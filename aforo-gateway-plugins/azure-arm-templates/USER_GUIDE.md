# Aforo Azure ARM Templates — User Guide

**Version:** 2.0.0 · **Updated:** 2026-10-27 · **Audience:** Azure subscription owners / platform engineers running Azure API Management.

## What you'll build

An Azure Policy, assigned in your subscription, that refuses `DELETE` on the APIM APIs and products you list and on APIM services tagged `aforo-monetized=true`.

## Prerequisites

- Permission to create policy definitions and assignments (`Resource Policy Contributor` or higher).
- Azure CLI (`az login`).
- A test APIM API you can try to delete.

## Step 1 — Deploy the definition and the assignment

```bash
az deployment sub create \
  --location eastus \
  --template-file aforo-monetized-deny-policy.json \
  --name aforo-deny-delete-monetized-deploy \
  --parameters protectedResources='["<apim-name>/<test-api-id>"]'
```

The API id is the APIM API name (`az apim api list -g <rg> -n <apim> --query "[].name"`), not its display name or path.

## Step 2 — Verify

```bash
az apim api delete --resource-group "<rg>" --service-name "<apim>" --api-id "<test-api-id>"
```

> ⚠ Expected: `403` with `RequestDisallowedByPolicy` naming `aforo-deny-delete-monetized`. A new assignment can take up to about 30 minutes to take effect.

To protect the whole instance, add the ARM tag:

```bash
az resource tag --tags aforo-monetized=true --ids "$(az apim show -g <rg> -n <apim> --query id -o tsv)"
```

## Step 3 — Delete a protected resource on purpose

Redeploy with the resource removed from `protectedResources` (or the service tag removed), then delete.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Delete still succeeds | The entry is not the exact `fullName` (`<apim-name>/<api-id>`), or the assignment is still being applied | Check the id; wait and retry. |
| Delete of the APIM service deletes its APIs | Policy does not block children deleted with their parent | Tag the service `aforo-monetized=true`. |
| Resource group delete removes everything | `denyAction` with mode `All` does not act on resource-group deletion | Put a `CanNotDelete` lock on the resource group. |
| `az deployment sub create` fails on scope | Deployed with `group create` | Use `az deployment sub create`. |

## What this guide does NOT cover

- APIM metering (`azure-apim`).
- Management-group-wide enforcement: deploy the definition at management-group scope and assign it there.
