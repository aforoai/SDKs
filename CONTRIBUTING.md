# Contributing

This repo is the public distribution home for Aforo's metering SDKs and gateway plugins. Each package is self-contained under `aforo-metering-sdks/` or `aforo-gateway-plugins/` and builds/tests independently.

## Layout

- `aforo-metering-sdks/<lang>[-<protocol>]/` — one package per language + protocol variant (Node, Python, Java, Go).
- `aforo-gateway-plugins/<gateway>/` — one folder per gateway plugin, plus `aws-cloudformation/`, `azure-arm-templates/`, and `docs/`.

## Working on a package

Build and test inside the package directory using that ecosystem's tooling:

| Language | Build / test |
|---|---|
| Node | `npm install && npm test && npm run build` |
| Python | `pip install -e '.[dev]' && pytest` |
| Java | `mvn clean test` |
| Go | `go test ./...` |

## Conventions

- **One package = one job.** Keep cross-cutting helpers within the package; don't add a shared root build.
- **No build artifacts in git.** `node_modules/`, `dist/`, `target/`, `_build/`, `*.egg-info/` are ignored — see `.gitignore`.
- **Every package needs a README** with a copy-paste install + a minimal working example before it's published.
- **Versioning.** Each package owns its version (package.json / pyproject / pom.xml / git tag). Releases are tag-driven per language.

## Publishing

Packages publish to public registries (npm `@aforoai/*`, PyPI `aforo-*`, Maven Central `ai.aforo:*`, Go modules) and gateway plugins to GitHub Releases. Release automation is per-language and tag-triggered.
