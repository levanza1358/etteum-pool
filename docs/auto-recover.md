# Auto-Recover (Codex)

Saat router butuh akun untuk provider tertentu tapi pool kosong (semua akun `exhausted` / `error`), Etteum bisa otomatis menjalankan satu putaran "warmup ringan" untuk membangunkan akun yang sebenarnya quota-nya sudah reset.

Dipakai sekarang oleh: **Codex** (provider lain bisa ditambah lewat daftar di `src/auth/warmup-runner.ts`).

---

## Mengapa Perlu

Codex pakai window quota berbasis waktu (`primary_window.reset_at`). Saat akun mencapai 100% used, kita tandai `exhausted`. Kalau user mengirim request lagi setelah window reset, akun sebenarnya sudah ready — tapi tanpa warmup manual, status DB masih `exhausted` dan router langsung melempar `No active accounts available for provider: codex`.

Auto-recover menutup celah itu: cek quota cepat untuk akun exhausted, kalau sudah reset → status flip ke `active`, request dilanjutkan.

---

## Cara Kerja

1. Router di `src/proxy/router.ts` memanggil `pool.getNextAccount("codex")`.
2. Kalau hasilnya `null` (pool kosong) **dan** provider termasuk daftar `AUTO_RECOVER_PROVIDERS` (`["codex"]`), router memicu `tryAutoRecoverProvider("codex")`.
3. Helper itu:
   - Mengambil maksimal `AUTO_RECOVER_BATCH_LIMIT` (8) akun status `exhausted` / `error` yang `enabled !== false`.
   - Menjalankan `warmupAccount()` paralel dengan timeout per-akun `AUTO_RECOVER_TIMEOUT_MS` (12 detik).
   - `warmupAccount` memanggil `provider.healthCheck()` → `fetchQuota` ke endpoint Codex usage.
   - Kalau quota window sudah reset (`remaining > 0`), `mapHealthToAccountUpdate` mengembalikan status `active`. Akun otomatis tersedia kembali di pool.
4. Router memanggil `pool.getNextAccount("codex")` sekali lagi. Kalau sudah ada → request lanjut. Kalau masih kosong → fallback ke error/combo seperti biasa.

Per-provider throttle: minimal `AUTO_RECOVER_COOLDOWN_MS` (30 detik) antar putaran. Kalau ada putaran lain yang masih jalan saat panggilan baru masuk, panggilan baru akan ikut menunggu hasilnya (dedup via `inFlight` promise) — jadi request yang datang berbarengan tidak menggandakan beban API.

---

## Kapan TIDAK Aktif

- Provider `byok`: routing pakai `getAccountForModel`, bukan `getNextAccount`. Auto-recover di-skip.
- Combo step: kalau combo cek `pool.hasActiveAccounts(provider)` dan dapat `false`, step di-skip dengan reason `no active accounts`. Auto-recover **tidak** otomatis dipanggil di sini — biar combo cepat lompat ke step berikutnya. Kalau primary attempt gagal lalu combo dipanggil, primary `tryProvider` itu sendiri akan memicu auto-recover di iterasi pertama.

---

## Konfigurasi

Konstanta di `src/auth/warmup-runner.ts`:

```ts
const AUTO_RECOVER_COOLDOWN_MS = 30_000;  // jarak minimum antar putaran per provider
const AUTO_RECOVER_BATCH_LIMIT = 8;        // batas akun yang dicek per putaran
const AUTO_RECOVER_TIMEOUT_MS  = 12_000;   // timeout per akun
export const AUTO_RECOVER_PROVIDERS: ProviderName[] = ["codex"];
```

Untuk menambahkan provider lain (misal `"codebuddy"`):

```ts
export const AUTO_RECOVER_PROVIDERS: ProviderName[] = ["codex", "codebuddy"];
```

Pastikan provider tsb. punya `fetchQuota` yang akurat (tidak menggunakan stale data) — kalau tidak, akun bisa salah-flip ke `active` lalu langsung gagal lagi.

---

## Logging

Saat dipicu:

```
[AutoRecover] codex: probing 5 exhausted/error account(s)…
[AutoRecover] codex: recovered 2 account(s).
```

atau:

```
[AutoRecover] codex: no accounts ready yet.
```

Detail per akun (sukses / gagal warmup) tetap tercatat di log warmup (`/api/auth/logs`) dan websocket event `warmup_*`.

---

## Edge Case

- **Semua akun benar-benar exhausted**: putaran selesai tanpa flip, router lempar `No active accounts available...`. Fallback combo bisa menangani ini.
- **Akun banyak (ratusan)**: hanya 8 yang dicek per putaran. Yang lain akan dapat giliran di putaran berikutnya (atau via auto-warmup scheduler regular).
- **Multiple request berbarengan**: hanya 1 putaran yang jalan; permintaan lain ikut hasilnya, tidak menggandakan call ke endpoint usage Codex.
