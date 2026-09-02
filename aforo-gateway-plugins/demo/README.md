# Aforo metering demo — end to end

Three parties, the way a real integration looks:

| Who | What it is | Here |
|---|---|---|
| **Nirmala** | end customer calling an API | `nirmala-frontend/` — static page, :3000 |
| **Suchith** | runs the API, bills for it via Aforo | `suchith-backend/` — Express, behind Kong |
| **Aforo** | metering + billing platform | `usage-ingestor` :8084, `pricing` :8083 (run separately) |

```
Nirmala's app ──JWT──▶ Kong ──verified headers──▶ Suchith's API
                        │
                        └── log phase, batched ──▶ Aforo usage-ingestor
                                                     └─ enrich → quota → budget → store
```

The thing worth watching: **Suchith's backend contains no metering code.** No JWT parsing, no usage tracking, no call to Aforo. Kong verifies the token, injects the identity, and reports usage. `suchith-backend/server.js` is ~90 lines and none of them are about billing.

## Prerequisites

Aforo's own services are **not** in this compose file — run them first:

- `usage-ingestor` on **:8084**, `pricing-service` on **:8083**
- postgres + redis, with redis reachable as container `aforo-redis`
- an API key row whose `key_id` matches `DEMO_KEY_ID`, bound to a subscription, with a `team_id`

Without that key row the traffic still flows and events still land — they just arrive
unattributed, and the budget panel stays empty.

## Where to find these values

The demo ships **placeholders**, not working values — a default that happens to
work would produce a demo that runs, meters into somebody else's tenant, and looks
fine while doing it. The generator refuses to run until you replace them, naming
the exact variables.

| Variable | Where to get it |
|---|---|
| `DEMO_TENANT_ID` | Your workspace id — the `X-Tenant-Id` the console sends, visible in the URL of your Aforo workspace |
| `DEMO_CUSTOMER_ID` | **Customers** → open the customer → its id (a UUID, not the display name) |
| `DEMO_SUBSCRIPTION_ID` | **Subscriptions** → the subscription binding that customer to an offering |
| `DEMO_KEY_ID` | **Developer Hub → Credentials** → create an API key → the `keyId` it returns. Not the `sk_live_…` secret — the plugin never sees that |
| `DEMO_TEAM_ID` | **Customers → Teams**, if you use teams |

Two of these decide whether the demo shows anything interesting:

- **`DEMO_KEY_ID`** must be a key bound to `DEMO_SUBSCRIPTION_ID`. It becomes the
  JWT's `key_id` claim, which the plugin forwards as `metadata.keyId`, which the
  ingestor resolves to a team. Get it wrong and events still arrive, but
  unattributed.
- **`DEMO_TEAM_ID`** must be set on that API key. Without a team, usage still
  bills correctly, but **team budgets never apply** and `summary-by-team` stays
  empty — so the budget panel has nothing to show.

Creating the key via `POST /api/v1/api-keys` returns the raw `sk_live_…` token
**once and only once**; reading the key back never returns it again. Store it
when you create it.

## Run it

```bash
cp .env.example .env                       # local stack — or .env.production.example for production
node scripts/generate-keys-and-config.js   # fresh RSA keypair + tokens + kong.yml
docker compose up --build
open http://localhost:3000
```

### Changing ports

`docker compose` and the generator both read `.env`, so set ports **there** rather than
inline — otherwise the page and the gateway disagree about which port Kong is on, and every
call fails with a CORS error that has nothing to do with CORS.

```bash
printf 'KONG_PROXY_PORT=8010\nKONG_ADMIN_PORT=8011\nFRONTEND_PORT=3010\n' >> .env
node scripts/generate-keys-and-config.js   # re-run so tokens.json picks up the new URL
docker compose up --build
```

One caveat on `FRONTEND_PORT`: the budget panel calls the ingestor directly, and the
ingestor allow-lists origins (`:3000`, `:3001`, `:5174`, `:5175` by default). On any other
port products still load — those go through Kong, which allows all origins — but the budget
panel shows a 403 until you add the origin to the ingestor's `CORS_ALLOWED_ORIGINS`. The
panel says so on screen rather than failing silently.

Then walk the flow, or run it non-interactively:

```bash
./scripts/test-flow.sh          # 8 checks, exits non-zero on failure
```

## What the demo shows

**Signature verification is real.** The token picker offers a *forged* token — identical
claims, signed by a different key. Kong returns `401 INVALID_SIGNATURE`; the request never
reaches Suchith. Switch to *expired* for `401 TOKEN_EXPIRED`, or *none* for a plain 401.

**Identity is carried, not guessed.** With a valid token the response includes `servedTo`,
which is what Suchith's backend read from Kong's injected headers. Those come from verified
JWT claims — the plugin overwrites any client-supplied values, so they cannot be spoofed.

**Usage is attributed to a team.** The `key_id` claim rides along as `metadata.keyId`. The
ingestor resolves it through its `identity_hierarchy:{tenant}:keyid:{keyId}` cache to a
team, member and subscription. That is what makes `summary-by-team` non-empty and what lets
team budgets apply at all.

**Budgets enforce.** Set one and exceed it:

```bash
./scripts/set-budget.sh 1     # limit of 1
./scripts/set-budget.sh clear
```

## Why Kong does not return 402

The obvious demo script is "budget runs out, Kong returns 402, Nirmala sees an error." That
is **not** what happens, and pretending otherwise would misrepresent the product.

The metering plugin runs in Kong's **log phase** — after the response has gone back to the
client — and buffers events for a batched flush. By the time Aforo evaluates the budget, the
request is long finished. Over budget, Kong keeps returning `200`; the ingestor rejects the
*event* with `402`. `test-flow.sh` asserts both, deliberately.

So this demo shows budget state as **observability**: the panel reads
`/v1/budget/status` and turns red when the limit is passed. That is honest, and it is what
the current plugin gives you.

Inline enforcement is a different mechanism: a **synchronous pre-flight check** in the access
phase, before proxying. The pieces exist — the ingestor serves `POST /api/v1/quota/check`
(Redis-only, sub-5ms, fail-open) and the plugin ships `preflight-quota.lua` — but that module
is not currently wired into `handler.lua`, and it checks quota rather than team budget. Ask
before promising a customer inline 402s.

## Layout

```
demo/
├── docker-compose.yml            Kong + backend + frontend
├── suchith-backend/              Express API, no metering code
├── nirmala-frontend/             static page: products, orders, budget panel
├── .env.example                  local stack — copy to .env, replace YOUR_* values
├── .env.production.example       Aforo production — same, with production URLs
├── kong/kong.yml                 GENERATED — cors + aforo-metering config
└── scripts/
    ├── generate-keys-and-config.js   keypair + tokens + kong.yml
    ├── set-budget.sh                 set/clear the team budget
    └── test-flow.sh                  8-step end-to-end check
```

## CORS

Kong's bundled `cors` plugin is enabled ahead of `aforo-metering` in the generated config,
and it is load-bearing for two reasons that are easy to miss:

- **Preflight.** Browsers send `OPTIONS` with **no** `Authorization` header. With only
  `aforo-metering` in the chain, JWT validation rejects the preflight with `401` and
  `POST /api/orders` can never succeed from a browser — while `curl` works fine, because
  curl sends no preflight.
- **Errors need CORS headers too.** Kong's own `401` responses carry none by default, so a
  rejected token surfaces in the browser as an opaque network failure instead of the clean
  `401` this demo exists to show.

Ordering matters: `cors` runs at priority ~2000, `aforo-metering` at 5, so `cors` handles
the preflight and short-circuits first.

Suchith's backend also sets permissive CORS headers, which covers requests that reach it.
Both layers are needed: the backend cannot add headers to a response Kong generated on
its own.

## Notes

The RSA keypair is generated, never committed — nothing here is a usable credential.
Re-run the generator to reset. `kong/kong.yml`, `tokens.json` and `.tokens.json` are
generated artifacts and are gitignored.

`set-budget.sh` writes the budget straight into the ingestor's Redis cache. In production
that config comes from customer-service; the shortcut keeps the demo to three containers.

`suchith-backend` publishes no host port on purpose — it is reachable only through Kong.
The `X-Customer-Id` header it trusts is only trustworthy because Kong overwrites it on
every request. Expose that port directly and the trust model is gone.
