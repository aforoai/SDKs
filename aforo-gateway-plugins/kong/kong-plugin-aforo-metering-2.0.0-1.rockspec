package = "kong-plugin-aforo-metering"
version = "2.0.0-1"

source = {
    url = "git+https://github.com/aforoai/kong-plugin-aforo-metering.git",
    tag = "v2.0.0",
}

description = {
    summary = "Kong plugin for automatic API usage metering with Aforo",
    detailed = [[
        Captures API usage events (method, path, consumer, latency, status)
        in Kong's log phase (zero latency impact) and forwards them in batches
        to Aforo's usage ingestor service for billing and analytics.
    ]],
    homepage = "https://github.com/aforoai/kong-plugin-aforo-metering",
    license = "Apache-2.0",
}

dependencies = {
    "lua >= 5.1",
    "lua-resty-http >= 0.17",
    -- No JWT rock is required. RS256 verification uses resty.openssl, which
    -- ships with Kong. lua-resty-jwt was tried and removed: it depends on
    -- lua-resty-hmac, whose FFI binding cannot load against OpenSSL 3 (Kong 3.x)
    -- -- "size of C type is unknown or too large", because HMAC_CTX became an
    -- opaque struct. No install method fixes that.
}

build = {
    type = "builtin",
    -- Every module handler.lua pulls in must be installed, not just the two
    -- Kong looks up by name. Shipping only handler + schema left the siblings
    -- absent from the rock entirely, so no require path could have resolved
    -- them and the plugin failed to load.
    modules = {
        ["kong.plugins.aforo-metering.handler"]            = "handler.lua",
        ["kong.plugins.aforo-metering.schema"]             = "schema.lua",
        ["kong.plugins.aforo-metering.rate-limit-enforce"] = "rate-limit-enforce.lua",
        ["kong.plugins.aforo-metering.margin-guard"]       = "margin-guard.lua",
        ["kong.plugins.aforo-metering.preflight-quota"]    = "preflight-quota.lua",
        ["kong.plugins.aforo-metering.compound-metering"]  = "compound-metering.lua",
    },
}
