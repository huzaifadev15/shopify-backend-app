# Shopify Backend App (Clean Folder)

This is a standalone backend folder for your Shopify custom pricing API.

## Folder setup

1. Copy your pricing file into:
   - `shopify-backend-app/data/pricing.json`
2. Copy `.env.example` to `.env`
3. Set a strong `QUOTE_SECRET`
4. (Optional but recommended) Set Shopify env vars:
   - `SHOPIFY_SHOP_DOMAIN`
   - `SHOPIFY_API_VERSION`
   - `SHOPIFY_ADMIN_ACCESS_TOKEN`

## Run

```bash
npm install
npm run dev
```

Server runs at `http://localhost:8787` by default.

## Endpoints

- `GET /`
- `GET /health`
- `POST /api/quote`
- `GET /api/shopify/check` (validates Admin API credentials)

## Example `POST /api/quote` body

```json
{
  "productName": "3D Embroidered patch",
  "width": 2,
  "height": 2.19,
  "qty": 10,
  "options": {
    "shape": "Circle",
    "borderStyle": "Merrowed Border",
    "backing": "Heat Applied"
  }
}
```

## Notes

- Matching includes aliases for `3D Embroidered patch`.
- Quote response includes:
  - `unitPrice`
  - `total`
  - `tier`
  - `quoteToken` (HMAC-signed)
- This backend alone does not override Shopify checkout pricing. For checkout to match your custom quote, you still need an active Shopify Function (App Discount or Cart Transform, depending on your plan/use-case).
