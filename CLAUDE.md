# CLAUDE.md

## MANDATORY: Change control (SOC 2 CC8.1)

- Never commit or push to `main`. Work on a branch `<developer>/<topic>`; the `main-change-control` ruleset rejects direct pushes.
- Commit as the developer running this session (their own git identity).
- One pull request per repo. A change that spans repos is one PR in each, cross-linked, with the merge order stated in each.
- Fill the PR template with the tests run. The `ci` check must pass (`require-ci` ruleset).
- Protected files go in their own PR, separate from application code, for Jay's review: any `.github/workflows/**`, any `.env.production` / `.env.staging`, and in aforo-nextgen-docker every `docker-compose*.yml`, `deploy/**` and `scripts/**`.
- Never approve, merge, enable auto-merge, or bypass a ruleset. A human other than the author approves.
- Hotfix: branch `hotfix/<topic>`, PR labelled `hotfix`, any second engineer approves, `ci` green. Only if no second engineer can be reached, an org owner may add a temporary ruleset bypass; it is recorded in aforo-docs `incidents/` and the change is reviewed within 1 business day. Full procedure: aforo-docs `CLAUDE.md`, "Change control (SOC 2 CC8.1)".
