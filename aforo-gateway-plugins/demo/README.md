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

## Run it

```bash
node scripts/generate-keys-and-config.js   # fresh RSA keypair + tokens + kong.yml
docker compose up --build
open http://localhost:3000
```

Ports 8000/8001/3000 already busy?

```bash
KONG_PROXY_PORT=8010 KONG_ADMIN_PORT=8011 FRONTEND_PORT=3010 docker compose up --build
```

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
├── kong/kong.yml                 GENERATED — service, route, plugin config
└── scripts/
    ├── generate-keys-and-config.js   keypair + tokens + kong.yml
    ├── set-budget.sh                 set/clear the team budget
    └── test-flow.sh                  8-step end-to-end check
```

## Notes

The RSA keypair is generated, never committed — nothing here is a usable credential.
Re-run the generator to reset. `kong/kong.yml`, `tokens.json` and `.tokens.json` are
generated artifacts and are gitignored.

`set-budget.sh` writes the budget straight into the ingestor's Redis cache. In production
that config comes from customer-service; the shortcut keeps the demo to three containers.

`suchith-backend` publishes no host port on purpose — it is reachable only through Kong.
The `X-Customer-Id` header it trusts is only trustworthy because Kong overwrites it on
every request. Expose that port directly and the trust model is gone.
