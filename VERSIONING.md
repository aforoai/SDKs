# Versioning & Releases

Every artifact in this repo carries its own version, recorded in **both code and docs**, and follows [Semantic Versioning](https://semver.org). This page is the convention; each artifact owns its own version line and changelog.

## Where the version lives

| Artifact type | Version in code | Released via |
|---|---|---|
| Node SDKs | `package.json` `"version"` | npm, on a git tag |
| Python SDKs | `pyproject.toml` / `setup.py` `version` | PyPI, on a git tag |
| Java SDKs | `pom.xml` `<version>` | Maven Central, on a git tag |
| Go SDKs | a `VERSION` file (Go has no manifest version field) | tag `aforo-metering-sdks/<pkg>/vX.Y.Z` (the module's repo subpath); import path is `github.com/aforoai/SDKs/aforo-metering-sdks/<pkg>` |
| Kong plugin | `*.rockspec` version | LuaRocks + GitHub Release |
| Other gateway plugins (Apigee/AWS/Azure/MuleSoft) | `package.json` (AWS) or a `VERSION` file | GitHub Release |
| EMQX plugin | `src/aforo_metering.app.src` `{vsn, ...}` | GitHub Release |
| IaC templates | a `VERSION` file | GitHub Release |

In docs, the version appears in two places per artifact — the **README** status line and the **`CHANGELOG.md`** top entry. The manifest, the README, and the changelog must agree.

## The rule: bump version + changelog in the same commit

When you change an artifact's behavior, in the **same commit**: bump its version (code) AND add the matching `CHANGELOG.md` entry (docs). A version that moves without a changelog entry — or a changelog entry without a version bump — is a review block.

## SemVer, per artifact

- **MAJOR** — a breaking API or behavior change for that artifact.
- **MINOR** — a backwards-compatible feature.
- **PATCH** — a backwards-compatible fix.

Each artifact versions independently. A Kong-plugin patch does not bump the Node SDK.

## Current versions (2026-10-02)

| Artifact | In this repo | Already published |
|---|---|---|
| `node`, `python`, `java`, `go` | `1.1.2` | `1.0.0` (npm, PyPI, Go tag); Java: none |
| `node-` / `python-` / `java-` / `go-` × `graphql`, `grpc`, `mqtt`; `python-ws` | `1.2.2` | `1.0.0`; Java: none |
| `node-ws`, `java-ws`, `go-ws` | `1.2.1` | `1.0.0`; Java: none |
| `node-mcp`, `python-mcp` | `1.3.2` | `1.0.0` |
| `mcp-proxy` | `1.2.2` | `1.0.0` |
| `node-agent` | `1.2.0` | `1.0.0` |
| `python-agent` | `0.3.2` | none |
| `mcp-test-server`, `agent-test-server` (internal, not published) | `0.1.0` | — |
| `aforo-gateway-plugins/` — `kong`, `aws-lambda`, `apigee`, `azure-apim`, `mulesoft` | `2.1.0` | GitHub Releases `2.1.0` |
| `aforo-emqx-plugin/` | `0.1.0` (experimental) | — |
| `aforo-gateway-plugins/aws-cloudformation`, `aforo-gateway-plugins/azure-arm-templates` | `1.0.0` | — |

The published `1.0.0` SDK artifacts predate the first sync from the working repo and must not be used; a published version can never be reused, so each module's next release is the version in the middle column. The gateway plugins, the SDKs and the EMQX plugin are independent lines, not a single repo-wide version.

## Releasing

Release automation is tag-driven per language (npm / PyPI / Maven Central / Go) and GitHub Releases for the gateway and broker plugins. Until each registry pipeline is live, a "release" is a git tag + a GitHub Release; consumers install from source — every artifact's README has the from-source steps.
