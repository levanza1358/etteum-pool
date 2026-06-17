# Account Management

Halaman: `http://<host>:1931/accounts/<provider>`

## Status

| Status | Arti |
|--------|------|
| `active` | Siap dipakai routing |
| `exhausted` | Quota/credit habis. Dilewati pool sampai warmup berhasil atau credit reset |
| `error` | Gagal otentikasi atau error berulang. Perlu retry login atau diperbaiki manual |
| `transient` | Gagal sementara (timeout/transient). Otomatis dipakai lagi setelah cooldown |
| `pending` | Belum login |
| `disabled` | Dimatikan manual oleh user |

## Bulk Actions

Toolbar di halaman list account per-provider:

- **Refresh** — reload list
- **Warmup All** — antrikan warmup untuk semua status (`active`/`exhausted`/`error`)
- **Retry Errors (N)** — antrikan login ulang untuk semua akun status `error`
- **Enable All / Disable All** — toggle flag enabled
- **Delete Exhausted (N)** — hapus akun status `exhausted` di provider ini
- **Delete Error (N)** — hapus akun status `error` di provider ini
- **Delete All (N)** — hapus semua akun di provider ini

Tombol disabled otomatis jika count = 0.

## API

```
GET    /api/accounts                                   — list (filter via ?provider=&status=)
POST   /api/accounts                                   — create
PATCH  /api/accounts/:id                               — update
DELETE /api/accounts/:id                               — delete one
POST   /api/accounts/:id/toggle                        — enable/disable
POST   /api/accounts/:id/login                         — antri login
POST   /api/accounts/:id/warmup                        — antri warmup
POST   /api/accounts/login                             — antri login massal (body: { ids: number[] })
POST   /api/accounts/warmup-all                        — antri warmup massal (body: { providers, statuses })
POST   /api/accounts/toggle-all                        — enable/disable semua di provider
DELETE /api/accounts/provider/:provider                — hapus semua di provider
DELETE /api/accounts/provider/:provider/status/:status — hapus by provider+status
```

`status` valid untuk delete-by-status: `active`, `exhausted`, `error`, `transient`, `pending`, `disabled`.

Semua endpoint delete melepas FK references (`request_logs.accountId`, `vcc_cards.usedByAccountId`, `vcc_transactions`) sebelum menghapus account, lalu invalidate pool cache + broadcast `accounts_updated` ke websocket.

## BYOK Notes

- Provider name di DB selalu `byok` (singular), tidak pernah `byok:<prefix>`.
- `email` digunakan sebagai label (mis. `aliyun-1`, `openrouter`).
- Tokens berisi JSON `{ base_url, format, models[], model_prefix, headers }`.
- Model lengkap = `<model_prefix>-<model>` (mis. `aliyun-ccai-pro`, `openrouter-gpt-4o`).
- `owned_by` di `/v1/models` selalu `byok` (sebelumnya `byok:<prefix>` — sekarang sudah dinormalisasi supaya dashboard combo picker mengelompokkan dalam satu grup `byok`).
