# Getting help

Pick the channel that matches what you need — it gets you an answer faster.

| You need… | Go to |
|---|---|
| How to install / integrate an SDK or plugin | The artifact's own `README.md` + `USER_GUIDE.md`, and the docs at [docs.aforo.ai](https://docs.aforo.ai) |
| A bug, crash, or wrong behavior in an artifact | [Open a GitHub issue](../../issues/new/choose) on this repo |
| A feature request for an SDK or plugin | [Open a GitHub issue](../../issues/new/choose) (feature request) |
| Account, billing, rate plans, or platform questions | support@aforo.ai or the Aforo console |
| A security vulnerability | **Not** a public issue — see [SECURITY.md](SECURITY.md) |

## Before opening an issue

- Check the artifact's `USER_GUIDE.md` **Troubleshooting** table — common symptoms
  (events not appearing, 401s, metric not billing) are answered there.
- Confirm the version you're on (the manifest or `VERSION` file) and include it.
- For "events aren't showing up in Aforo," verify the three values first:
  `aforo_endpoint`, `api_key`, `tenant_id`. Most reports trace back to one of these.

## What makes a fast-to-answer issue

Use the issue template. The essentials: the **artifact + version**, your **runtime
version** (Node/Python/JVM/Go/gateway), a **minimal reproduction**, what you
**expected vs. saw**, and any **non-sensitive** logs. Never paste an API key or
tenant secret into an issue.

## Response expectations

This repository is maintained by the Aforo team. Issues are triaged on business
days; there is no guaranteed SLA on community issues here — for contractual
support, use your Aforo support agreement via support@aforo.ai.
