# Aforo SDKs & Gateway Plugins

[![CI](https://github.com/aforoai/SDKs/actions/workflows/ci.yml/badge.svg)](https://github.com/aforoai/SDKs/actions/workflows/ci.yml)

Meter your product's usage and send it to Aforo for billing — in code with a language SDK, or with zero code at your API gateway. Everything in this repo is what you install to get usage events flowing into Aforo.

> **Distribution status:** these packages are being prepared for public registries (npm · PyPI · Maven Central · Go modules) and the gateway plugins for tagged GitHub Releases. Until a package is published, install it from source — each package directory has its own README with the steps. The integration model below is stable.

---

## Pick your integration

| You want to… | Use | Where |
|---|---|---|
| Meter from inside your service code | A language SDK + framework middleware | [`aforo-metering-sdks/`](aforo-metering-sdks/) |
| Meter without touching app code | A gateway plugin (Tier 0) | [`aforo-gateway-plugins/`](aforo-gateway-plugins/) |
| Meter an MQTT broker (EMQX) | The broker plugin | [`aforo-emqx-plugin/`](aforo-emqx-plugin/) |
| Meter a GraphQL / gRPC / WebSocket / MQTT surface | A protocol-specific SDK | `aforo-metering-sdks/<lang>-<protocol>/` |
| Meter AI agents or MCP tool calls | An MCP/agent SDK or the transport proxy | `aforo-metering-sdks/{node-mcp, python-mcp, mcp-proxy, node-agent}` |
| Send events with no SDK at all | Direct REST `POST /v1/ingest/batch` | See "Common model" below |

Most teams start with a gateway plugin (no code) or the base SDK for their language, then add protocol/MCP variants as needed.

---

## What's here

### `aforo-metering-sdks/` — language SDKs (24 packages)

| Language | Base | GraphQL | gRPC | WebSocket | MQTT | MCP | Agent | Proxy (CLI) |
|---|---|---|---|---|---|---|---|---|
| **Node** | `node` | `node-graphql` | `node-grpc` | `node-ws` | `node-mqtt` | `node-mcp` | `node-agent` | `mcp-proxy` |
| **Python** | `python` | `python-graphql` | `python-grpc` | `python-ws` | `python-mqtt` | `python-mcp` | — | — |
| **Java** | `java` | `java-graphql` | `java-grpc` | `java-ws` | `java-mqtt` | — | — | — |
| **Go** | `go` | `go-graphql` | `go-grpc` | `go-ws` | `go-mqtt` | — | — | — |

Base SDKs ship framework middleware (Express/Fastify/Koa, FastAPI/Django/Flask, Spring Boot servlet filter, net/http + Chi). The MCP SDKs wrap your tool handlers to auto-meter tool invocations; the transport proxy meters stdio/SSE MCP servers without code changes.

### `aforo-gateway-plugins/` — API gateway plugins (Tier 0, zero code)

| Gateway | Folder | Artifact |
|---|---|---|
| Kong | [`aforo-gateway-plugins/kong`](aforo-gateway-plugins/kong) | Lua plugin (`.rockspec`) |
| Apigee | [`aforo-gateway-plugins/apigee`](aforo-gateway-plugins/apigee) | Shared-flow bundle (JS callout) |
| AWS API Gateway | [`aforo-gateway-plugins/aws-lambda`](aforo-gateway-plugins/aws-lambda) | Lambda + SAM template + JWT authorizer |
| Azure APIM | [`aforo-gateway-plugins/azure-apim`](aforo-gateway-plugins/azure-apim) | Outbound XML/C# policy |
| MuleSoft | [`aforo-gateway-plugins/mulesoft`](aforo-gateway-plugins/mulesoft) | DataWeave custom policy |

Plus IaC templates in [`aforo-gateway-plugins/aws-cloudformation`](aforo-gateway-plugins/aws-cloudformation) and [`aforo-gateway-plugins/azure-arm-templates`](aforo-gateway-plugins/azure-arm-templates), and per-gateway deployment notes in [`aforo-gateway-plugins/docs`](aforo-gateway-plugins/docs). All five gateway plugins detect MCP `tools/call` JSON-RPC and meter the tool name + agent id alongside standard HTTP requests.

### `aforo-emqx-plugin/` — MQTT broker plugin *(experimental)*

Broker-level metering for [EMQX](https://www.emqx.io/) 5.x — an Erlang OTP plugin that meters MQTT client connections, publishes, and subscriptions at the broker instead of at an API gateway. See [`aforo-emqx-plugin/README.md`](aforo-emqx-plugin/README.md).

---

## Docs & versioning

Every artifact ships three docs in its own folder: a **README** (install + quickstart + config table), a **USER_GUIDE.md** (step-by-step walkthrough to a verified event in Aforo), and a **CHANGELOG.md**. Each carries its own version — in the manifest (`package.json` / `setup.py` / `pom.xml` / `.rockspec`) or a `VERSION` file (Go, Apigee, IaC) — recorded in both code and docs. See [VERSIONING.md](VERSIONING.md) for the per-artifact SemVer convention.

---

## Common model

Everything here funnels usage to one ingestion API. Base SDKs and the gateway/broker plugins batch events and `POST /v1/ingest/batch` (plugins do it from the log/response phase, non-blocking). The protocol SDKs (GraphQL/gRPC/WebSocket/MQTT) post to `/v1/ingest/events`, and the agent SDK posts to `/v1/ingest` — each package's README states the exact path it uses.

- **Endpoint base:** `https://ingest.aforo.ai` (override per environment); the path is `/v1/ingest/batch`, `/v1/ingest/events`, or `/v1/ingest` depending on the SDK — see the package README.
- **Auth:** `Authorization: Bearer <AFORO_API_KEY>`
- **Tenant scope:** your tenant id, supplied via SDK config or plugin config — never read from a client-settable request header

Gateway/broker plugins take three values: `aforo_endpoint`, `api_key`, `tenant_id`. Each plugin README shows where to set them.

---

## Repo layout

```
SDKs/
├── aforo-metering-sdks/    # language SDKs (Node / Python / Java / Go × base + protocols + MCP/agent)
├── aforo-gateway-plugins/  # API gateway plugins (Kong / Apigee / AWS / Azure / MuleSoft) + IaC + docs
├── aforo-emqx-plugin/      # MQTT broker (EMQX) metering plugin — experimental
├── .github/                # CI + release/publish workflows, issue/PR templates, CODEOWNERS
├── VERSIONING.md           # per-artifact SemVer convention (version in code + docs)
├── PUBLISHING.md           # release + registry-publish runbook (maintainers)
├── CONTRIBUTING.md
├── SECURITY.md · SUPPORT.md · CODE_OF_CONDUCT.md
├── README.md
└── LICENSE
```

## License

Apache License 2.0 — see [LICENSE](LICENSE).
