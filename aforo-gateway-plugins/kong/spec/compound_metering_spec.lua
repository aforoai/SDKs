-- Unit tests for the compound-metering module's frozen correlationId
-- (A+ compound-key freeze, 2026-07-05).
-- Run with: busted spec/
--
-- The correlationId is the dedup ROOT for a compound event — the ingestor
-- decomposes it into correlationId:metricName[:dimensionKey]:index — so it
-- must be (a) UUID-shaped (the server DTO types it as UUID), (b) derived
-- purely from stable per-request identity (byte-identical across rebuilds
-- and delivery retries), and (c) NEVER shared across distinct requests
-- (a shared id makes the server silently dedup real events — revenue loss).
--
-- ngx.md5 is mocked with REAL md5 digests (precomputed via node:crypto)
-- for the exact strings the module is expected to hash, so these tests
-- verify both the seed string construction and the UUID formatting
-- against node-verified reference values.

local REAL_MD5 = {
    ["aforo-compound:req-hdr-1"]       = "47525e33efafb88070a0711af33ca354",
    ["aforo-compound:ngxreqid_abc123"] = "615ff0086ff6f1f77691bac78fad2308",
    ["aforo-compound:ngxreqid_def456"] = "70cf3e2a8bcedd16df918beb89663c23",
}

local mock_state = {
    header_value = nil,
    warn_called  = false,
}

_G.ngx = {
    md5 = function(s)
        local h = REAL_MD5[s]
        assert(h ~= nil, "module hashed an unexpected string: " .. tostring(s))
        return h
    end,
    now = function() return 1751700000 end,
    var = { request_id = "ngxreqid_abc123" },
}

_G.kong = {
    request = {
        get_header = function(name)
            return mock_state.header_value
        end,
    },
    log = {
        warn  = function() mock_state.warn_called = true end,
        debug = function() end,
    },
}

-- compound-metering.lua requires cjson.safe at file scope (used only by
-- extract_measurements, which is not under test here).
package.loaded["cjson.safe"] = package.loaded["cjson.safe"]
    or { decode = function() return nil end }

-- The last-resort correlationId now comes from resty.jit-uuid (real Kong bundles it);
-- the old kong.tools.uuid() was nil on the Kong 3.x PDK global and crashed the build.
package.loaded["resty.jit-uuid"] = { generate_v4 = function() return "random-fallback-uuid" end }

local compound = require("compound-metering")

describe("compound-metering frozen correlationId", function()

    local measurements = { { metricName = "input-tokens", quantity = 500 } }

    before_each(function()
        mock_state.header_value = nil
        mock_state.warn_called  = false
        ngx.var.request_id      = "ngxreqid_abc123"
    end)

    it("derives a node-verified v3 UUID from ngx.var.request_id", function()
        local event = compound.build_compound_event("cust_abc", measurements, {})
        assert.are.equal("615ff008-6ff6-31f7-b691-bac78fad2308", event.correlationId)
    end)

    it("ignores a client X-Request-Id: repeating it must not collapse calls", function()
        -- The client controls X-Request-Id. Seeding from it let a caller
        -- repeat one value on every request and have every repeat
        -- deduplicated by the ingestor (billed once for many calls).
        mock_state.header_value = "req-hdr-1"
        local e1 = compound.build_compound_event("cust_abc", measurements, {})
        ngx.var.request_id = "ngxreqid_def456"
        local e2 = compound.build_compound_event("cust_abc", measurements, {})
        assert.are.equal("615ff008-6ff6-31f7-b691-bac78fad2308", e1.correlationId)
        assert.are.equal("70cf3e2a-8bce-3d16-9f91-8beb89663c23", e2.correlationId)
        assert.are_not.equal(e1.correlationId, e2.correlationId)
    end)

    it("is byte-identical across rebuilds (flush retry / redelivery dedups)", function()
        local e1 = compound.build_compound_event("cust_abc", measurements, {})
        local e2 = compound.build_compound_event("cust_abc", measurements, {})
        assert.are.equal(e1.correlationId, e2.correlationId)
    end)

    it("is a valid v3-style UUID (server DTO types correlationId as UUID)", function()
        local event = compound.build_compound_event("cust_abc", measurements, {})
        assert.is_truthy(event.correlationId:match(
            "^%x%x%x%x%x%x%x%x%-%x%x%x%x%-3%x%x%x%-[89ab]%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$"))
    end)

    it("treats an EMPTY request id as absent (Lua: '' is truthy)", function()
        -- Deriving from "" would give every such request the SAME
        -- correlationId and the ingestor would silently dedup real events.
        ngx.var.request_id = ""
        local event = compound.build_compound_event("cust_abc", measurements, {})
        assert.are.equal("random-fallback-uuid", event.correlationId)
        assert.is_true(mock_state.warn_called)
    end)

    it("uses a random last resort + warn only when no identity exists at all", function()
        mock_state.header_value = "req-hdr-1"
        ngx.var.request_id = nil
        local event = compound.build_compound_event("cust_abc", measurements, {})
        assert.are.equal("random-fallback-uuid", event.correlationId)
        assert.is_true(mock_state.warn_called)
    end)

    it("source never seeds the correlationId from a request header", function()
        local f = io.open("./compound-metering.lua", "rb")
            or io.open("compound-metering.lua", "rb")
        local src = f:read("*all"); f:close()
        for line in src:gmatch("[^\n]+") do
            if not line:find("^%s*%-%-") then
                assert.is_nil(line:find("get_header"),
                    "compound-metering.lua must not read request headers: " .. line)
            end
        end
    end)

    it("returns nil for empty measurements", function()
        assert.is_nil(compound.build_compound_event("cust_abc", {}, {}))
        assert.is_nil(compound.build_compound_event("cust_abc", nil, {}))
    end)

    it("source never references kong.tools (would crash on Kong 3.x)", function()
        local f = io.open("./compound-metering.lua", "rb")
            or io.open("compound-metering.lua", "rb")
        assert.is_not_nil(f, "compound-metering.lua must be readable from spec/ cwd")
        local src = f:read("*all"); f:close()
        assert.is_nil(src:find("kong%.tools"),
            "compound-metering.lua must not reference kong.tools — it is nil on the "
                .. "Kong 3.x PDK global and crashes the build. Use resty.jit-uuid.")
    end)
end)
