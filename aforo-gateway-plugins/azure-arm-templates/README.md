# Aforo Azure ARM Templates

An Azure Resource Manager template that defines and assigns an Azure Policy blocking deletion of the API Management resources Aforo bills on.

**Version:** 2.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## When to reach for this

Reach for this when you run Azure API Management and want a guardrail against deleting an APIM API or product that Aforo is billing on. The policy uses the `denyAction` effect: a `DELETE` on a protected resource is refused with `403`, and removal becomes a two-step you can't fat-finger — take the resource off the list, then delete.

There is no metering here; APIM metering runs in the `azure-apim` policy fragments.

| Template | What it creates |
|---|---|
| `aforo-monetized-deny-policy.json` | The policy definition `aforo-deny-delete-monetized` (effect `denyAction`, action `delete`) and its assignment at subscription scope. |

## What it protects

- **APIs and products you list** in `protectedResources`, as `<apim-service-name>/<api-or-product-id>` (the resource's `fullName`, for example `contoso-apim/orders-api`). APIM APIs and products do not support ARM tags, so they are matched by name.
- **APIM services tagged `aforo-monetized=true`** (ARM tag on the `Microsoft.ApiManagement/service` resource), when `protectMonetizedServices` is `true` (default).

Azure Policy does not block a child that is deleted together with its parent: deleting the APIM service deletes its APIs. That is why the service-level rule exists. A resource-group delete is not blocked by a policy in mode `All`; use a resource lock on the group for that.

## Install

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-gateway-plugins/azure-arm-templates

az deployment sub create \
  --location eastus \
  --template-file aforo-monetized-deny-policy.json \
  --parameters protectedResources='["contoso-apim/orders-api","contoso-apim/gold"]'
```

## Configuration

| Parameter | Default | |
|---|---|---|
| `protectedResources` | `[]` | `<apim-service-name>/<api-or-product-id>` values |
| `protectMonetizedServices` | `true` | also protect APIM services tagged `aforo-monetized=true` |
| `enforcementMode` | `Default` | `DoNotEnforce` to evaluate without blocking |

The assignment is created at subscription scope. To narrow it, delete it and assign the definition yourself with `az policy assignment create --scope <resource-group-id>`.

## Walk me through it

[USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **The metering itself** — `azure-apim`.
- **Keeping the list in step with Aforo.** Aforo does not update `protectedResources` for you; redeploy with the new list when a product starts or stops being billed.
- **Resource-group deletion** (see above).
