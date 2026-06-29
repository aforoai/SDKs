# Publishing & Releases

How a maintainer cuts a release and ships an artifact to its registry. Each
artifact versions independently — see [VERSIONING.md](VERSIONING.md).

## The release flow

1. **Bump + changelog in one commit.** Raise the artifact's version (manifest or
   `VERSION` file) AND add the matching `CHANGELOG.md` entry, in the same commit.
   CI must be green.
2. **Tag it.** Push a tag using the convention for that artifact:

   | Artifact | Tag | Example |
   |---|---|---|
   | Node / Python / Java / gateway / EMQX | `<artifact>-v<version>` | `node-v1.0.1`, `kong-v2.0.1` |
   | Go modules | `aforo-metering-sdks/<pkg>/v<version>` *(required by the Go proxy)* | `aforo-metering-sdks/go/v1.0.1` |

   ```bash
   git tag node-v1.0.1 && git push origin node-v1.0.1
   ```
3. **GitHub Release** is created automatically by `.github/workflows/release.yml`
   (no secrets needed).
4. **Publish to the registry** (not Go — see below) by running the matching
   workflow: *Actions → "Publish — npm / PyPI / Maven Central" → Run workflow →
   enter the package directory*. Manual on purpose, so a mistagged push never
   auto-publishes.

**Go needs no publish step.** The tag *is* the release; `go get
github.com/aforoai/SDKs/aforo-metering-sdks/<pkg>@<tag>` fetches it through the
module proxy once the repo is public.

## One-time registry setup

Until these are done, the publish workflows are present but dormant — install
from source still works (every README has the steps).

| Registry | What to set up | Auth |
|---|---|---|
| **npm** | Own the `aforoai` org/scope on npmjs.org | `NPM_TOKEN` secret, or npm Trusted Publishing (then no token) |
| **PyPI** | Register the `aforo-*` project names; add a Trusted Publisher for this repo + `publish-pypi.yml` + the `pypi` environment | OIDC — no token stored |
| **Maven Central** | Claim a namespace on the Central Portal (decide `com.aforo` vs `ai.aforo`); create + publish a GPG key | `MAVEN_CENTRAL_USERNAME/PASSWORD`, `MAVEN_GPG_PRIVATE_KEY/PASSPHRASE` secrets |
| **Go** | Nothing beyond making the repo public + tagging | none |

### Maven Central — pom prerequisites

Central rejects artifacts missing required metadata. Each Java module pom needs,
in addition to the current `groupId`/`artifactId`/`version`:

- `<name>`, `<description>`, `<url>`
- `<licenses>` (Apache-2.0), `<scm>` (this repo), `<developers>`
- the `maven-source-plugin` and `maven-javadoc-plugin` (Central requires sources
  + javadoc jars)
- the `maven-gpg-plugin` (signs artifacts) and the `central-publishing-maven-plugin`
  (or `nexus-staging-maven-plugin`) wired to the `central` server id used in
  `publish-maven.yml`

This pom work is gated on the namespace decision (`com.aforo` vs `ai.aforo`); do
it once the Sonatype namespace is claimed.

## Pre-release / release candidates

Tags containing `-alpha`, `-beta`, or `-rc` are marked as GitHub pre-releases
automatically. Publish them to a registry only if you intend a public pre-release
(npm `--tag next`, PyPI pre-release version, etc.).

## Checklist before the first public release

- [ ] Repo made **public**
- [ ] Branch protection on `main` + CI a **required** check
- [ ] Registry namespaces claimed (npm / PyPI / Maven) + secrets/OIDC configured
- [ ] Maven poms given Central metadata + signing (see above)
- [ ] Contact addresses in `SECURITY.md` / `SUPPORT.md` confirmed
- [ ] `@aforoai/sdk-maintainers` team created (referenced by `CODEOWNERS`)
- [ ] Customer docs on docs.aforo.ai published, then announce
