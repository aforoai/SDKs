# Security Policy

These SDKs and plugins sit on the request path of production billing systems and
carry credentials (Aforo API keys, gateway secrets). We take reports seriously
and respond quickly.

## Reporting a vulnerability

**Do not open a public GitHub issue for security reports.**

Report privately through either channel:

- **GitHub** — open a private advisory: *Security → Report a vulnerability* on this
  repository ([GitHub private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).
- **Email** — security@aforo.ai. Encrypt with our PGP key if the report contains
  sensitive detail.

Please include: the affected artifact and version, a description, reproduction
steps or a proof of concept, and the impact you've assessed.

## What to expect

| Stage | Target |
|---|---|
| Acknowledgement of your report | within 2 business days |
| Initial assessment + severity | within 5 business days |
| Fix or mitigation for a confirmed high/critical issue | within 30 days |
| Coordinated disclosure | after a fix ships, by mutual agreement |

We credit reporters in the release notes unless you ask us not to.

## Scope

In scope: any artifact in this repository — the language SDKs
(`aforo-metering-sdks/`), the gateway plugins (`aforo-gateway-plugins/`), and the
EMQX broker plugin (`aforo-emqx-plugin/`).

Out of scope: the Aforo platform services themselves (report those to
security@aforo.ai directly), and findings that require a misconfigured host you
already control (e.g. a leaked API key you committed to your own repo).

## Handling credentials safely

- Pass `api_key` / `tenant_id` through environment variables or your secret
  manager — never commit them, and never read tenant scope from a client-settable
  request header. Each SDK's user guide shows the safe call site.
- Rotate an Aforo API key immediately in the Aforo console if you suspect it
  leaked; revocation takes effect without a code change.

## Supported versions

Each artifact is versioned independently (see [VERSIONING.md](VERSIONING.md)).
Security fixes land on the latest released line of the affected artifact. Older
lines are patched only when an issue is critical and the line is in active use.
