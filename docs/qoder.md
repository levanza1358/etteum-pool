# Qoder Provider — Quota & Error Handling

Catatan tentang bagaimana Etteum mendeteksi dan menangani kegagalan upstream Qoder, supaya combo fallback dan auto-cleanup bekerja konsisten.

---

## Permasalahan

Qoder kadang merespons "soft failure" dengan cara yang menyesatkan:

1. **HTTP 200 + body error di SSE.** Status HTTP sukses, tapi event stream berisi `{"statusCodeValue": 4xx, "message": "..."}`. Tanpa penanganan khusus, router melihat ini sebagai sukses.
2. **HTTP 400 BAD_REQUEST untuk quota habis.** Bukan 429 — Qoder kadang mengembalikan 400 dengan body `"rate limited or quota exceeded"`. Default semantic 400 adalah "request invalid", tapi di sini sebenarnya quota issue.

Akibat yang dulu muncul:
- Account Qoder yang quota-nya habis tetap berstatus `active`.
- Combo nyangkut di step Qoder karena tidak return `success: false`.
- Request log tampak "success" padahal user dapat error chunk.

---

## Mapping Status Code → Aksi Sekarang

Diimplementasikan di `src/proxy/providers/qoder.ts` (`chatCompletionStream`).

| Status / kondisi | Aksi |
|------------------|------|
| HTTP 401 | Return `{ success: false, error: "expired: HTTP 401" }`. Router auto-refresh token; jika tetap gagal, mark transient. |
| HTTP 403 | Return `{ success: false, quotaExhausted: true, error: "Rate limited or quota exceeded" }`. Account ditandai `exhausted`. |
| HTTP 429 | Return `{ success: false, rateLimited: true, quotaExhausted: true, error: "Qoder HTTP 429: ..." }`. |
| HTTP 400 dengan body mengandung `rate limit` / `quota` / `exceed` | Return `{ success: false, quotaExhausted: true, error: "Qoder HTTP 400 BAD_REQUEST: rate limited or quota exceeded" }`. |
| HTTP 5xx lain | Return `{ success: false, error: "Qoder chat HTTP <code>: <body>" }`. Combo retry sesuai `retryOn`. |
| HTTP 200, lalu prefetch SSE menemukan `statusCodeValue >= 400` sebelum content pertama | Return fail. `quotaExhausted: true` jika message berisi keyword quota; `rateLimited: true` jika 429 atau pesan rate limit. |
| HTTP 200, content valid duluan, error muncul di tengah stream | Tidak bisa di-rollback (sudah dikirim ke client). Stream akan emit error chunk + `[DONE]` lalu finalizer menandai account exhausted. |

### Stream Prefetch

`chatCompletionStream` membaca beberapa chunk awal upstream sebelum mengembalikan `ReadableStream` ke router. Ini supaya error yang muncul di SSE body terdeteksi sebelum router commit ke "stream sudah dimulai = sukses".

Chunk yang sudah di-prefetch dimasukkan kembali ke buffer stream output sehingga **tidak ada data yang hilang** untuk client.

---

## Efek Domino

- **Account marking.** `quotaExhausted` → `pool.markExhausted(accountId)` → status DB jadi `exhausted`. Akun kembali aktif setelah warmup atau quota reset (sesuai logika provider).
- **Combo fallback.** Karena `success: false`, router tahu ini gagal dan lanjut ke step combo berikutnya.
- **Bulk cleanup.** Akun `exhausted` dapat dibersihkan via tombol `Delete Exhausted` di `/accounts/<provider>` atau endpoint `DELETE /api/accounts/provider/qoder/status/exhausted`.

---

## Debugging

Cek log saat tombak dipakai:

```bash
.\etteum.ps1 logs
```

Pola yang berguna:

- `[Qoder] Stream timeout` — upstream lambat
- `[Qoder] Stream read error` — koneksi putus
- `[Combo] Step N failed: Qoder HTTP 400 BAD_REQUEST: ...` — fallback bekerja
- `[Combo] Reached maxRetries cap` — combo berhenti karena budget habis
- `[Combo] Step <provider/model> is in cooldown` — step di-skip otomatis

Jika ingin reset cooldown step (untuk testing), restart service: cooldown disimpan in-memory.
