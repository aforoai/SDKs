# Nirmala's frontend

One static `index.html` — no build, no framework, no dependencies. Served by nginx on
:3000 in compose, or open the file directly.

## What is on the page

**Token picker** (top right) — switch between a valid token, a *forged* one (same claims,
different signing key), an *expired* one, and no token. Every request uses the current
selection, so you can show a rejection without editing anything.

**Products / orders** — each button is one call through Kong, which is one metered event.
"Send 10 requests" builds usage quickly.

**Budget panel** — polls the ingestor's `/v1/budget/status` every 10s and turns amber at
75%, red at 100%.

**Activity log + last response** — every call with its status, and the raw body.

## Ports

Served on **:3000** deliberately: that origin is already in the ingestor's
`CORS_ALLOWED_ORIGINS`, so the budget panel works with no extra config. On another port
the products still load (they go through Kong) but the budget panel will fail CORS.

## Where the budget number comes from

Not from Suchith's API — Suchith does not know about budgets. The page reads Aforo's
ingestor directly, which is the honest picture: the gateway serves traffic, Aforo owns the
billing state.

Note that a request can succeed while the budget is exhausted. That is not a bug in the
page — see "Why Kong does not return 402" in the parent README.

## Generated file

`tokens.json` is written by `scripts/generate-keys-and-config.js` and gitignored. Without
it the page loads but has no tokens to send.
