package = "kong-plugin-aforo-metering"
version = "2.2.0-1"

-- Released from the public repository github.com/aforoai/SDKs, where the plugin
-- lives in aforo-gateway-plugins/kong/ and is tagged kong-vX.Y.Z. `dir` points
-- LuaRocks at that subdirectory of the clone, so the module paths below are
-- relative to this file. From a checkout (either repository), run
-- `luarocks make kong-plugin-aforo-metering-2.2.0-1.rockspec` in this directory.
source = {
    url = "git+https://github.com/aforoai/SDKs.git",
    tag = "kong-v2.2.0",
    dir = "SDKs/aforo-gateway-plugins/kong",
}

description = {
    summary = "Kong plugin that meters API usage into Aforo",
    detailed = [[
        Records one usage event per proxied request (HTTP, MCP tools/call,
        gRPC, GraphQL, WebSocket handshake) in Kong's log phase and sends
        them in batches to the Aforo usage ingestor. Optional access-phase
        checks: JWT validation, rate limit, pre-flight quota, margin guard.
    ]],
    homepage = "https://github.com/aforoai/SDKs/tree/main/aforo-gateway-plugins/kong",
    license = "Apache-2.0",
}

dependencies = {
    "lua >= 5.1",
    "lua-resty-http >= 0.17",
    -- No JWT rock. RS256 verification uses resty.openssl, which ships with
    -- Kong. lua-resty-jwt depends on lua-resty-hmac, whose FFI binding cannot
    -- load against OpenSSL 3 (Kong 3.x).
}

build = {
    type = "builtin",
    -- Every Lua module in this directory. handler.lua requires the three
    -- access-phase helpers as kong.plugins.aforo-metering.<name> (falling back
    -- to the bare name when run from a source tree); compound-metering is
    -- shipped for integrations that call it directly.
    modules = {
        ["kong.plugins.aforo-metering.handler"]            = "handler.lua",
        ["kong.plugins.aforo-metering.schema"]             = "schema.lua",
        ["kong.plugins.aforo-metering.rate-limit-enforce"] = "rate-limit-enforce.lua",
        ["kong.plugins.aforo-metering.margin-guard"]       = "margin-guard.lua",
        ["kong.plugins.aforo-metering.preflight-quota"]    = "preflight-quota.lua",
        ["kong.plugins.aforo-metering.compound-metering"]  = "compound-metering.lua",
    },
}
