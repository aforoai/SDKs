# Publishing & Releases

How a developer cuts a release and ships an artifact to its registry — runnable
end-to-end from a laptop with the [`gh`](https://cli.github.com) CLI. Each
artifact versions independently (see [VERSIONING.md](VERSIONING.md)). Publishing
runs in GitHub Actions; the laptop's job is to set secrets, push tags, and
trigger the workflows.

Steps are marked **[laptop]** (a developer with repo admin can run it) or
**[web]** (needs a registry-account or org owner). Until the one-time setup is
done the publish workflows sit dormant — installing from source still works, and
every README documents it.

---

## Prerequisites (laptop)

macOS; skip anything already installed.

```bash
# Homebrew, if `brew` is missing:
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

brew install gh gnupg node python   # gh = GitHub CLI, gnupg = gpg (Maven signing)
gh auth login
gh repo clone aforoai/SDKs && cd SDKs
```

The developer needs **push + admin** on `aforoai/SDKs` (admin is required to set
Actions secrets and trigger workflows). Adding the team member or claiming
registry namespaces additionally needs org-owner / registry-account-owner rights.

---

## Step A — Maven namespace decision (do first)

The Java poms use `com.aforo` today. Keep it (no change) **or** switch to
`ai.aforo` (edit `<groupId>` in the five `aforo-metering-sdks/java*/pom.xml`).
Maven Central requires you to *own* whichever namespace you pick. Settle this
before claiming the namespace in Step C.

## Step B — npm setup

1. **[web]** Confirm Aforo owns the `@aforo` scope on npmjs.org.
2. **[laptop]** Set the publish token (an npm *automation* token with publish rights):
   ```bash
   gh secret set NPM_TOKEN --repo aforoai/SDKs
   ```
   (Provenance is already wired via `id-token: write`. If you prefer npm Trusted
   Publishing, configure it on npmjs.org and the token can be dropped.)

## Step C — Maven Central setup

1. **[web]** Claim the namespace from Step A at <https://central.sonatype.com> and
   verify ownership.
2. **[laptop]** Generate + publish a GPG signing key:
   ```bash
   gpg --gen-key
   gpg --keyserver keyserver.ubuntu.com --send-keys <KEY_ID>
   gpg --armor --export-secret-keys <KEY_ID> > /tmp/aforo-signing-key.asc
   ```
3. **[laptop]** Set the four secrets, then shred the key file:
   ```bash
   gh secret set MAVEN_CENTRAL_USERNAME --repo aforoai/SDKs        # Central Portal token user
   gh secret set MAVEN_CENTRAL_PASSWORD --repo aforoai/SDKs        # Central Portal token pass
   gh secret set MAVEN_GPG_PRIVATE_KEY  --repo aforoai/SDKs < /tmp/aforo-signing-key.asc
   gh secret set MAVEN_GPG_PASSPHRASE   --repo aforoai/SDKs        # the key's passphrase
   rm /tmp/aforo-signing-key.asc
   ```

> The pom metadata Central requires (`name`/`url`/`licenses`/`scm`/`developers`)
> and the source/javadoc/gpg/central-publishing plugins are **already in the
> poms**, gated behind a `release` profile so `mvn test` is unaffected.
> `publish-maven.yml` runs `mvn -Prelease deploy`. No pom work remains unless you
> switch the namespace (Step A).

## Step D — PyPI setup (no token — OIDC)

1. **[web]** Register each project name (`aforo-metering`, etc.). For each:
   *Project → Publishing → Add a new publisher* → Repository `aforoai/SDKs`,
   Workflow `publish-pypi.yml`, Environment `pypi`.
   (<https://docs.pypi.org/trusted-publishers/>)
2. **[laptop]** Create the matching GitHub environment the workflow binds to:
   ```bash
   gh api -X PUT repos/aforoai/SDKs/environments/pypi
   ```

## Step E — Maintainers team (org owner)

The `@aforoai/sdk-maintainers` team (referenced by `CODEOWNERS`) needs members or
review requests can't be auto-assigned:
```bash
gh api -X PUT orgs/aforoai/teams/sdk-maintainers/memberships/<github-username>
```

---

## Step F — Launch sequence (laptop): tag → release → publish

Make sure `main` holds the version you're shipping and CI is green. Tag formats
(from [VERSIONING.md](VERSIONING.md)):

| Artifact | Tag | Example |
|---|---|---|
| Node / Python / Java / gateway / EMQX | `<artifact>-v<version>` | `node-v1.0.0`, `kong-v2.0.0` |
| Go modules | `aforo-metering-sdks/<pkg>/v<version>` *(required by the Go proxy)* | `aforo-metering-sdks/go/v1.0.0` |

```bash
# 1. Tag + push. release.yml cuts the GitHub Release automatically (no secrets).
git tag node-v1.0.0
git push origin node-v1.0.0

# 2. Publish FROM that exact tagged commit — --ref pins it so main drift can't leak in.
gh workflow run "Publish — npm" --repo aforoai/SDKs --ref node-v1.0.0 \
  -f package_dir=aforo-metering-sdks/node

# 3. Watch the run.
gh run watch --repo aforoai/SDKs
```

Repeat per artifact, swapping the workflow + input:

```bash
# Python  (input: package_dir; runs in the `pypi` environment, OIDC):
gh workflow run "Publish — PyPI" --ref python-v1.0.0 \
  -f package_dir=aforo-metering-sdks/python

# Java / Maven  (input: module_dir):
gh workflow run "Publish — Maven Central" --ref java-v1.0.0 \
  -f module_dir=aforo-metering-sdks/java

# Go — NO publish workflow. The tag IS the release; the module proxy serves it:
git tag aforo-metering-sdks/go/v1.0.0 && git push origin aforo-metering-sdks/go/v1.0.0
```

The `gh workflow run` calls are `workflow_dispatch`-only, so a publish happens
**only** when explicitly triggered — a mistagged push never auto-publishes.

### Artifacts to loop through

- **8 npm**: `node, node-agent, node-mcp, mcp-proxy, node-graphql, node-grpc, node-ws, node-mqtt`
- **6 PyPI**: `python, python-mcp, python-graphql, python-grpc, python-ws, python-mqtt`
- **5 Maven**: `java, java-graphql, java-grpc, java-ws, java-mqtt`
- **5 Go** (tag only): `go, go-graphql, go-grpc, go-ws, go-mqtt`
- **Gateway plugins / EMQX** ship from source — tag them for versioning, but
  there's no registry publish step.

---

## Pre-release / release candidates

Tags containing `-alpha`, `-beta`, or `-rc` are marked as GitHub pre-releases
automatically. Publish them to a registry only for an intentional public
pre-release (npm `--tag next`, a PyPI pre-release version, etc.).

## Checklist before the first public release

- [x] Repo **public**, branch protection on `main`, CI a **required** check
- [x] Maven poms carry Central metadata + signing (in the `release` profile)
- [x] Contact addresses in `SECURITY.md` / `SUPPORT.md` (support@aforo.ai)
- [ ] Maven namespace decided (`com.aforo` vs `ai.aforo`) — Step A
- [ ] Registry namespaces claimed + secrets/OIDC configured — Steps B/C/D
- [ ] `@aforoai/sdk-maintainers` team has members — Step E
- [ ] Customer docs on docs.aforo.ai published, then announce
