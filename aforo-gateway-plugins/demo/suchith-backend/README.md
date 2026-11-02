# Suchith's backend

The API being metered. Express, in-memory data, ~90 lines.

```
GET  /api/products       list
GET  /api/products/:id   one
POST /api/orders         {productId, quantity}
GET  /api/orders/:id     one
GET  /health             excluded from metering by the plugin's exclude_paths
```

## The point of this service

It has **no metering code**. No JWT library, no signature check, no usage counter, no call
to Aforo. Kong verified the token before proxying and reports the usage afterwards.

Identity arrives as headers Kong sets from verified JWT claims:

| Header | From |
|---|---|
| `X-Customer-Id` | `customer_id` claim |
| `X-Tenant-Id` | `tenant_id` claim |
| `X-Key-Id` | `key_id` claim |
| `X-Scopes` | `scopes` claim |

Every response echoes these back as `servedTo`, so you can see what the backend received.

**These headers are trustworthy only because Kong overwrites them on every request.** The
plugin deliberately ignores client-supplied values. Run this service on a port clients can
reach directly and anyone can claim to be any customer — so it publishes no host port in
`docker-compose.yml`, and reaching it means going through Kong.

## Run standalone

```bash
npm install && npm start        # :9000
curl localhost:9000/api/products
```

Called directly, `servedTo` is all nulls — there is no Kong to populate it.
