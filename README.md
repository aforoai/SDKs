# Aforo SDKs & Gateway Plugins

Meter your product's usage and send it to Aforo for billing — in code with a language SDK, or with zero code at your API gateway. Everything in this repo is what you install to get usage events flowing into Aforo.

> **Distribution status:** these packages are being prepared for public registries (npm · PyPI · Maven Central · Go modules) and the gateway plugins for tagged GitHub Releases. Until a package is published, install it from source — each package directory has its own README with the steps. The integration model below is stable.

---

## Pick your integration

| You want to… | Use | Where |
|---|---|---|
| Meter from inside your service code | A language SDK + framework middleware | [`sdks/`](sdks/) |
| Meter without touching app code | A gateway plugin (Tier 0) | [`plugins/`](plugins/) |
| Meter a GraphQL / gRPC / WebSocket / MQTT surface | A protocol-specific SDK | `sdks/<lang>-<protocol>/` |
| Meter AI agents or MCP tool calls | An MCP/agent SDK or the transport proxy | `sdks/node-mcp`, `sdks/python-mcp`, `sdks/mcp-proxy`, `sdks/node-agent` |
| Send events with no SDK at all | Direct REST `POST /v1/ingest/batch` | See "Common model" below |

Most teams start with a gateway plugin (no code) or the base SDK for their language, then add protocol/MCP variants as needed.

---

## What's here

### `sdks/` — language SDKs (24 packages)

| Language | Base | GraphQL | gRPC | WebSocket | MQTT | MCP | Agent | Proxy (CLI) |
|---|---|---|---|---|---|---|---|---|
| **Node** | `node` | `node-graphql` | `node-grpc` | `node-ws` | `node-mqtt` | `node-mcp` | `node-agent` | `mcp-proxy` |
| **Python** | `python` | `python-graphql` | `python-grpc` | `python-ws` | `python-mqtt` | `python-mcp` | — | — |
| **Java** | `java` | `java-graphql` | `java-grpc` | `java-ws` | `java-mqtt` | — | — | — |
| **Go** | `go` | `go-graphql` | `go-grpc` | `go-ws` | `go-mqtt` | — | — | — |

Base SDKs ship framework middleware (Express/Fastify/Koa, FastAPI/Django/Flask, Spring Boot servlet filter, net/http + Chi). The MCP SDKs wrap your tool handlers to auto-meter tool invocations; the transport proxy meters stdio/SSE MCP servers without code changes.

### `plugins/` — API gateway & broker plugins (Tier 0, zero code)

| Gateway | Folder | Artifact |
|---|---|---|
| Kong | [`plugins/kong`](plugins/kong) | Lua plugin (`.rockspec`) |
| Apigee | [`plugins/apigee`](plugins/apigee) | Shared-flow bundle (JS callout) |
| AWS API Gateway | [`plugins/aws-lambda`](plugins/aws-lambda) | Lambda + SAM template + JWT authorizer |
| Azure APIM | [`plugins/azure-apim`](plugins/azure-apim) | Outbound XML/C# policy |
| MuleSoft | [`plugins/mulesoft`](plugins/mulesoft) | DataWeave custom policy |
| EMQX (MQTT broker) | [`plugins/emqx`](plugins/emqx) | Erlang OTP plugin *(experimental)* |

Plus IaC templates in [`plugins/aws-cloudformation`](plugins/aws-cloudformation) and [`plugins/azure-arm-templates`](plugins/azure-arm-templates), and per-gateway deployment notes in [`plugins/docs`](plugins/docs). All five gateway plugins detect MCP `tools/call` JSON-RPC and meter the tool name + agent id alongside standard HTTP requests.

---

## Common model

Everything here funnels usage to one place. The SDKs batch events and `POST /v1/ingest/batch`; the gateway plugins do the same from the log/response phase (non-blocking).

- **Endpoint:** `https://ingest.aforo.ai/v1/ingest/batch` (override per environment)
- **Auth:** `Authorization: Bearer <AFORO_API_KEY>`
- **Tenant scope:** your tenant id, supplied via SDK config or plugin config — never read from a client-settable request header

Gateway plugins take three values: `aforo_endpoint`, `api_key`, `tenant_id`. Each plugin README shows where to set them for that gateway.

---

## Repo layout

```
SDKs/
├── sdks/                  # language SDKs (Node / Python / Java / Go × base + protocols + MCP/agent)
├── plugins/               # gateway plugins (Kong / Apigee / AWS / Azure / MuleSoft / EMQX) + IaC + docs
├── README.md
├── LICENSE
└── CONTRIBUTING.md
```

## License

Apache License 2.0 — see [LICENSE](LICENSE).
