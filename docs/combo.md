# Combo Fallback

Combo Fallback adalah sistem multi-provider + multi-model failover. Saat satu request ke provider/model tertentu gagal (rate limit, quota habis, error 5xx, timeout, dll), sistem otomatis mencoba step berikutnya di chain sampai ada yang berhasil — atau semua step habis.

Halaman dashboard: `http://<host>:1931/combo`

---

## Konsep Singkat

Combo Rule punya dua mode pemicu:

1. **Direct Combo (`Model ID`)** — User request langsung pakai nama combo. Chain dieksekusi dari step 1.
2. **Pattern Fallback (`Trigger Model`)** — User request pakai model normal. Primary provider dicoba dulu, kalau gagal baru chain combo dipakai.

Kedua mode bisa dipakai bersamaan dalam satu rule. Salah satu wajib diisi (lihat validasi di bawah).

---

## Field Rule

| Field | Tipe | Wajib | Keterangan |
|-------|------|-------|------------|
| `name` | string | – | Label rule (mis. `"Family Chain"`) |
| `modelId` | string | salah satu dari `modelId`/`triggerModel` | Nama combo virtual yang muncul di `/v1/models` (mis. `"best"`, `"family"`). User request langsung dengan nama ini → langsung jalankan chain dari step 1. |
| `triggerModel` | string | salah satu dari `modelId`/`triggerModel` | Pattern pencocokan model masuk untuk fallback (mis. `"opus"`, `"claude"`). Aktif hanya saat primary provider gagal. |
| `matchType` | `"exact"` \| `"contains"` \| `"prefix"` | – | Cara mencocokkan `triggerModel` dengan model request |
| `steps` | `ComboStep[]` | ya | Daftar urut `{ provider, model }` yang akan dicoba |
| `maxRetries` | number | – | Maks. jumlah **attempt nyata** ke fallback. `0` = tanpa batas (coba semua step). Skip tidak menghabiskan budget. |
| `retryOn` | string[] | – | Kondisi error yang memicu retry ke step berikutnya |
| `enabled` | boolean | – | Aktifkan/non-aktifkan rule |
| `priority` | number | – | Lebih kecil = dievaluasi lebih dulu saat ada beberapa rule |

### `ComboStep`

```ts
{ provider: "kiro" | "kiro-pro" | "codebuddy" | "canva" | "codex" | "qoder" | "byok",
  model:   "kr-claude-sonnet-4.5-thinking" | "krp-claude-opus-4.7-thinking" | ... }
```

Untuk BYOK, `provider` selalu `"byok"` (bukan `"byok:aliyun"` atau `"byok:openrouter"`). Prefix model (`aliyun-...`, `openrouter-...`, dll) sudah cukup untuk routing internal.

### Validasi pembuatan rule

- `modelId` ATAU `triggerModel` salah satu wajib ada (boleh keduanya).
- `steps` minimal 1 entry, masing-masing wajib punya `provider` dan `model`.
- Jika `modelId` saja yang diisi, rule tidak akan terpicu lewat pattern fallback — hanya saat user request persis `modelId`.

---

## Match Type

| Type | Trigger | Match request |
|------|---------|---------------|
| `exact` | `claude-opus-4` | hanya `claude-opus-4` |
| `contains` | `opus` | semua model yang mengandung `opus` (case-insensitive) |
| `prefix` | `cb-opus` | model yang diawali `cb-opus-...` |

`contains` cocok untuk mencakup banyak varian (`claude-opus-4`, `cb-opus-4.6`, `krp-claude-opus-...`).

---

## Retry Conditions (`retryOn`)

Daftar kondisi yang memicu retry ke step berikutnya. Multi-pilih.

| Value | Memicu retry pada |
|-------|-------------------|
| `quota_exhausted` | Provider menandai quota/credit habis |
| `rate_limit` | HTTP 429 atau provider menandai rate-limited |
| `auth_error` | HTTP 401/403, `unauthorized`, `forbidden` |
| `server_error` | HTTP 500/502/503/504, "internal server error", "service unavailable" |
| `bad_gateway` | HTTP 502/503, "bad gateway" |
| `overloaded` | HTTP 503/529, "overloaded", "too busy" |
| `timeout` | "timeout", "etimedout", "aborted" |
| `error` | Catch-all untuk error generik (selain content/model issue) |
| `http_XXX` | Custom: cocokkan kode HTTP eksak di pesan error (mis. `http_503`, `http_529`) |

`http_XXX` berguna kalau provider tertentu pakai status code non-standar. Edit lewat API atau langsung ke kolom `retry_on` di tabel `combo_rules` (JSON array string).

Content error (`moderation`, `invalid_model`, `model_not_found`, `sensitive content`) **tidak pernah** trigger retry, terlepas dari `retryOn`.

---

## Cara Combo Memilih Step

Untuk Direct Combo dan Pattern Fallback, loop iterate semua step di chain. Tiap step bisa di-**skip** atau **dicoba**:

### Skip — TIDAK menghabiskan budget `maxRetries`

- Step adalah duplikat primary (provider+model sama dengan request awal — pattern fallback only)
- Provider tidak terdaftar di registry (mis. typo/legacy `byok:aliyun`)
- Step sedang dalam **cooldown** (lihat di bawah)
- Provider tidak punya akun aktif (`hasActiveAccounts === false`)

### Attempt — MENGHABISKAN budget `maxRetries`

- Selain skip di atas, step dicoba via `tryProvider`
- Jika sukses → return ke client, attach `comboInfo` (rule, originalModel, usedStep, attemptedSteps)
- Jika gagal → cek `shouldComboRetry(error)` lalu lanjut step berikutnya
- Step dengan timeout per-attempt: `COMBO_STEP_TIMEOUT_MS`

Setelah `maxRetries` attempt nyata habis (atau semua step iteratable habis), rule throw error dengan format:

```
Combo "<name>" exhausted N attempt(s) (out of M steps in chain).
Tried: <provider/model> → <provider/model> → ...
Skipped: <provider/model> (duplicate of primary), <provider/model> (cooldown), ...
Last error: <last step error>
```

`Skipped` muncul kalau ada step yang di-skip — gunanya untuk debug.

---

## Step Cooldown

Tiap pasangan `provider/model` punya counter kegagalan internal:

- Kegagalan beruntun ≥ `COOLDOWN_THRESHOLD` (5) → step di-cooldown selama `COOLDOWN_DURATION_MS` (10 menit).
- Step yang sukses meresetkan counter.
- Saat cooldown aktif, step di-skip otomatis (tidak menghabiskan budget). Setelah expired, otomatis kembali tersedia.

---

## Provider-Level Fast-Fail (Qoder)

Beberapa provider (terutama Qoder) kadang mengembalikan **HTTP 200 dengan body error** (rate limit / quota habis di dalam payload SSE). Tanpa penanganan khusus, request akan terlihat "sukses" oleh router meski upstream gagal — combo tidak fallback dan account tidak ditandai exhausted.

Yang ditangani sekarang:

| Trigger | Aksi |
|---------|------|
| HTTP 401 | Refresh token; jika gagal → mark transient |
| HTTP 403 | Mark `quotaExhausted` (rate limit / quota) |
| HTTP 429 | Mark `quotaExhausted` + `rateLimited` |
| HTTP 400 dengan body mengandung `rate limit` / `quota` / `exceed` | Mark `quotaExhausted` (Qoder kadang melaporkan quota issue sebagai 400 BAD_REQUEST) |
| HTTP 5xx | `success: false` dengan pesan asli — combo retry sesuai `retryOn` |
| Stream prefetch: `statusCodeValue >= 400` di SSE body sebelum content pertama | Return `success: false` dengan `quotaExhausted` jika message mengandung quota/rate keyword |

Akibatnya: account Qoder yang menerima `Qoder HTTP 400 BAD_REQUEST: rate limited or quota exceeded` otomatis ditandai `exhausted`, dan combo lanjut ke step berikutnya — tidak nyangkut.

---

## Akun Bulk Cleanup

Setelah combo aktif sering memark akun `exhausted` atau `error`, halaman provider account (`Accounts → <provider>`) menyediakan tombol bulk:

- **Delete Exhausted (N)** — hapus semua akun status `exhausted`
- **Delete Error (N)** — hapus semua akun status `error`
- **Delete All (N)** — hapus semua akun di provider tsb.

Backend endpoint baru:

```
DELETE /api/accounts/provider/:provider/status/:status
```

`status` valid: `active`, `exhausted`, `error`, `transient`, `pending`, `disabled`.

---

## API

Combo rules:

```
GET    /api/combo                     — list semua rule + status master
GET    /api/combo/:id                  — detail rule
POST   /api/combo                      — buat rule baru
PUT    /api/combo/:id                  — update rule (partial)
DELETE /api/combo/:id                  — hapus rule
GET    /api/combo/models               — daftar provider+model untuk picker
GET    /api/combo/stats                — statistik penggunaan combo
POST   /api/combo/import               — import banyak rule (replace/merge)
```

Body create/update minimal:

```json
{
  "name": "Family Chain",
  "modelId": "family",
  "triggerModel": "opus",
  "matchType": "contains",
  "steps": [
    { "provider": "codex",     "model": "codex-gpt-5.4" },
    { "provider": "codebuddy", "model": "cb-opus-4.6" },
    { "provider": "kiro-pro",  "model": "krp-claude-opus-4.7-thinking" },
    { "provider": "kiro",      "model": "kr-claude-sonnet-4.5-thinking" },
    { "provider": "qoder",     "model": "qd-Auto" },
    { "provider": "byok",      "model": "aliyun-deepseek-v3.2" }
  ],
  "maxRetries": 0,
  "retryOn": ["quota_exhausted", "rate_limit", "server_error", "overloaded", "timeout", "error"],
  "enabled": true,
  "priority": 0
}
```

---

## Resep Umum

### 1. "Coba semua provider sampai ada yang berhasil"

```yaml
modelId: family
triggerModel: opus
matchType: contains
maxRetries: 0           # unlimited
retryOn: [quota_exhausted, rate_limit, server_error, overloaded, timeout, error]
steps: [...semua provider...]
```

User request `claude-opus-4` → primary fail → chain habis-habisan sampai sukses.

### 2. "Hanya combo eksplisit, jangan ganggu request normal"

```yaml
modelId: best-claude
triggerModel: ""        # kosong → tidak terpicu pattern
matchType: contains
```

User harus request `best-claude` secara eksplisit. Request `claude-opus-4` tetap pakai routing normal tanpa fallback.

### 3. "Hanya retry maksimal 3 attempt nyata"

```yaml
maxRetries: 3
```

Skip step (duplicate, cooldown, no accounts) tidak menghabiskan budget. Jadi 3 attempt = 3 provider yang benar-benar dipanggil.

### 4. "Backup pakai provider Aliyun"

```yaml
steps:
  - { provider: codebuddy, model: cb-opus-4.6 }
  - { provider: kiro-pro,  model: krp-claude-opus-4.7-thinking }
  - { provider: byok,      model: aliyun-ccai-pro }
  - { provider: byok,      model: aliyun-deepseek-v3.2 }
```

Provider `byok` (bukan `byok:<prefix>`). Model prefix sudah otomatis route ke akun BYOK yang sesuai.

---

## Migrasi Data Lama

Rule yang dibuat sebelum normalisasi BYOK kemungkinan masih punya `provider: "byok:aliyun"`. Itu akan diskip dengan reason `unknown provider`. Cara cepat memperbaiki tanpa edit manual:

```ts
// fix-combo.ts
import { Database } from "bun:sqlite";
const db = new Database("./data/poolprox3.db");

const rows = db.query("SELECT id, steps FROM combo_rules").all() as any[];
for (const row of rows) {
  const steps = JSON.parse(row.steps);
  let changed = false;
  for (const s of steps) {
    if (s.provider?.startsWith("byok:")) {
      s.provider = "byok";
      changed = true;
    }
  }
  if (changed) {
    db.query("UPDATE combo_rules SET steps = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(steps), Math.floor(Date.now() / 1000), row.id);
    console.log(`Fixed rule #${row.id}`);
  }
}
```

Jalankan: `bun fix-combo.ts` lalu `etteum restart`.
