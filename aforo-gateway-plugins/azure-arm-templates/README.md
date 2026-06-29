# Aforo Azure ARM Templates

An Azure Resource Manager template that defines an Azure Policy denying deletion of API Management resources tagged as monetized by Aforo.

**Version:** 1.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## When to reach for this

Reach for this when you run Azure API Management and want a guardrail against accidentally deleting an APIM API or product that Aforo is actively billing on. It deploys an Azure Policy definition that **denies** delete operations on APIM APIs and products tagged `aforo-monetized=true`. Removal becomes a two-step you can't fat-finger: clear the monetized tag in Aforo first, then delete.

This is infrastructure-as-code you deploy into your own Azure subscription. There is no package to install and no metering here — APIM metering runs in the separate `azure-apim` policy fragments.

| Template | What it creates |
|---|---|
| `aforo-monetized-deny-policy.json` | An Azure Policy definition `aforo-deny-delete-monetized` (effect: `deny`) covering `Microsoft.ApiManagement/service/apis` and `.../products` tagged `aforo-monetized=true`. |

## Install

This is an ARM template, not a package. The repo is **not yet published** publicly; deploy the JSON directly.

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-gateway-plugins/azure-arm-templates
```

## Quickstart

Deploy the policy definition at subscription scope, then assign it (deny policies only enforce once assigned):

```bash
# 1. Create the policy definition from the template's resource.
az deployment sub create \
  --location eastus \
  --template-file aforo-monetized-deny-policy.json

# 2. Assign it so the deny effect takes hold.
az policy assignment create \
  --name aforo-deny-delete-monetized \
  --policy aforo-deny-delete-monetized \
  --scope "/subscriptions/<subscription-id>"
```

## Configuration

The template takes no parameters — the matched resource types and the `aforo-monetized=true` tag condition are fixed in the policy rule.

| Field | Value | What it does |
|---|---|---|
| Policy name | `aforo-deny-delete-monetized` | The definition's name; reference it when assigning. |
| `policyType` | `Custom` | A custom (not built-in) policy definition. |
| `mode` | `All` | Evaluates resource types that don't support tags/location too. |
| Matched types | `Microsoft.ApiManagement/service/apis`, `.../products` | The APIM resources protected. |
| Tag condition | `tags['aforo-monetized'] == 'true'` | Only tagged resources are protected. |
| Effect | `deny` on `actionType == delete` | Blocks the delete. |

> ⚠ A policy **definition** does nothing until it's **assigned** to a scope. Step 2 of the quickstart is not optional — without the assignment the deny never fires.

## Walk me through it

Deploy the definition → assign it at the right scope → confirm a delete on a tagged resource is blocked: [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **The metering itself.** APIM usage events come from the `azure-apim` policy fragments, not this template.
- **Tagging resources.** Aforo applies `aforo-monetized=true` when a product is monetized; this policy only acts on already-tagged resources.
- **Removing the guardrail to delete.** Clear the `aforo-monetized` tag in Aforo before deleting a protected resource — that's the intended workflow, not a bypass.
