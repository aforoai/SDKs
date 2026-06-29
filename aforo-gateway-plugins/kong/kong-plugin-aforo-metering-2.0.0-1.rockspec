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
}

build = {
    type = "builtin",
    modules = {
        ["kong.plugins.aforo-metering.handler"] = "handler.lua",
        ["kong.plugins.aforo-metering.schema"]  = "schema.lua",
    },
}
