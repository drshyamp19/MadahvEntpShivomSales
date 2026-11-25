# MADHAV ENTERPRISES & SHIVOM SALES - 100% Cloudflare-Only ERP

Cloudflare Workers + Static Assets + SQLite-backed Durable Objects + WebSocket Hibernation API ERP Portal.

## Architecture

- **100% Cloudflare-Only**: No Vercel, no Firebase, no Google Drive, no R2 billing requirement.
- **Dual Brand Workers (`cloudflare.config.ts`)**:
  - `madhav-enterprises`: `https://madhav-enterprises.madhavshivom.workers.dev` (Madhav Enterprises branding, OG preview, PWA manifest; hosts the `ErpLedgerDO` SQLite Durable Objects)
  - `shivom-sales`: `https://shivom-sales.madhavshivom.workers.dev` (Shivom Sales & Services branding, OG preview, PWA manifest; bound to the shared `ErpLedgerDO` instances)
- **Independent SQLite Durable Objects**: Separate DO instances (`getByName("MADHAV")` and `getByName("SHIVOM")`) auto-seeded on first access:
  - `MADHAV`: 560 Parties (₹10,66,177 opening balance), 29 Products, Team Directory
  - `SHIVOM`: 63 Parties, 11 Products, 44 Orders, 57 Collections, Team Directory
- **Real-Time Multi-Device Sync**: WebSocket Hibernation API broadcasts mutations immediately across connected Admin/Staff devices without page reloads.
- **Live Customer Document Links (`?view=...`) & Media Storage**: Invoices, Order Memos, Receipts, Challans, and Party Statements open live from DO SQLite with instant client-side PDF download. Compressed cheque/payment proof photos are stored directly in DO SQLite `media`.
- **Android App**: `android-app/` WebView wrapper configured for both Cloudflare Workers domains.

## Development & Deployment

```bash
npm install
npm test
npm run typecheck
npm run build            # Build Madhav Worker (default)
cf build --mode shivom   # Build Shivom Worker
cf deploy                # Deploy Madhav Worker
cf deploy --mode shivom  # Deploy Shivom Worker
```
