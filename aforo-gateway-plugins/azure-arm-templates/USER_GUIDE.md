# Aforo Azure ARM Templates — User Guide

**Version:** 1.0.0 · **Updated:** 2026-06-29 · **Audience:** Azure subscription owners / platform engineers running Azure API Management.

## What you'll build

An Azure Policy in your subscription that blocks deletion of APIM APIs and products tagged `aforo-monetized=true`. By the end you'll have deployed and assigned the policy and confirmed a delete on a tagged resource is denied.

## Prerequisites

- An Azure subscription with permission to create policy definitions and assignments (`Resource Policy Contributor` or higher).
- Azure CLI configured (`az login`), or access to the Azure portal Policy blade.
- At least one APIM API or product (real or test) you can tag, to verify the deny.

## Step 1 — Deploy the policy definition

The template's resource is a `Microsoft.Authorization/policyDefinitions`, so deploy it at subscription scope:

```bash
az deployment sub create \
  --location eastus \
  --template-file aforo-monetized-deny-policy.json \
  --name aforo-deny-delete-monetized-deploy
```

This creates the custom policy definition `aforo-deny-delete-monetized`. It takes no parameters.

## Step 2 — Assign the policy

A definition alone enforces nothing. Assign it at the scope you want protected (subscription, resource group, or a specific APIM service):

```bash
az policy assignment create \
  --name aforo-deny-delete-monetized \
  --display-name "Aforo: deny delete of monetized APIM resources" \
  --policy aforo-deny-delete-monetized \
  --scope "/subscriptions/<subscription-id>"
```

> ⚠ This is the step people skip. Without the assignment the deny effect never evaluates. Scope it as narrowly as makes sense — assigning at the APIM resource group is usually enough.

## Step 3 — Verify the guardrail

Tag a test APIM API (or confirm an Aforo-monetized one is tagged), then attempt to delete it:

```bash
# Tag a test API as monetized (Aforo does this automatically for real products).
az apim api update \
  --resource-group "<rg>" --service-name "<apim>" --api-id "<test-api>" \
  --set tags.aforo-monetized=true

# Attempt the delete — expect it to be denied by policy.
az apim api delete \
  --resource-group "<rg>" --service-name "<apim>" --api-id "<test-api>"
```

> ⚠ Expected: the delete is rejected with `RequestDisallowedByPolicy` naming `aforo-deny-delete-monetized`. If it succeeds, the assignment is missing (Step 2) or the resource isn't actually tagged `aforo-monetized=true`.

To delete a protected resource through the intended workflow: clear the monetized tag in Aforo (which removes `aforo-monetized=true`), then delete.

## Configuration reference

The template is parameterless. The protected resource types (`Microsoft.ApiManagement/service/apis`, `.../products`), the `tags['aforo-monetized'] == 'true'` condition, and the `deny` effect on delete are fixed in the policy rule. To change scope, change the **assignment** scope (Step 2), not the template.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Delete of a tagged resource still succeeds | The policy definition was deployed but never assigned. | Run Step 2 (`az policy assignment create`) at a scope that covers the resource. |
| Delete succeeds despite an assignment | The resource isn't tagged `aforo-monetized=true` (or the tag value differs). | Confirm the exact tag key/value; Aforo sets it on monetized products. |
| `az deployment sub create` fails on scope | The resource is a `policyDefinitions` type, which deploys at subscription (or management-group) scope, not resource-group. | Use `az deployment sub create` (or `mg create`), not `group create`. |
| Policy assignment shows compliant but doesn't block | `deny` is an enforcement effect, not a compliance scan — it acts at delete time. Compliance state is informational. | Test by attempting an actual delete (Step 3); don't rely on the compliance dashboard for deny behavior. |
| Need to permanently remove a monetized API | The guardrail is intentional. | Clear the `aforo-monetized` tag in Aforo first, then delete — or remove the policy assignment if you're decommissioning the guardrail. |

## What this guide does NOT cover

- **APIM metering** — that's the `azure-apim` policy fragments, separate from this template.
- **Management-group-wide enforcement** — assign at `mg` scope instead of subscription if you need org-wide coverage; that's an Azure governance choice.
- **Custom tag keys.** The policy matches `aforo-monetized` specifically; changing the matched tag means editing the policy rule (template logic), which is out of scope for this deployment guide.
