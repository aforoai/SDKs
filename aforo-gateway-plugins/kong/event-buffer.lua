-- Aforo event buffer and delivery for Kong Gateway.
--
-- handler.lua's log phase hands each JSON-encoded event to M.push(conf, json).
-- Timers drain the buffer to the ingestor's batch endpoint (aforo_endpoint).
-- Nothing here runs on the request path except the push and the scheduling
-- checks next to it.
--
-- Shared memory: the aforo_buffer dict (lua_shared_dict aforo_buffer 10m).
-- One buffer per plugin instance and destination -- aforo_endpoint +
-- tenant_id + api_key (hashed) + the plugin's own id. Per buffer it holds:
--   <key>            the events, a list, one encoded event per element
--   <key>:conf       the buffer's delivery settings (endpoint, key, tenant...)
--   <key>:lock       a flush is running (at most one per buffer, all workers)
--   <key>:pending    a timed flush is scheduled
--   <key>:kick       an immediate (flush_count) flush is scheduled
--   <key>:backoff    the last flush failed; no immediate flush until it expires
--   <key>:failing    the last flush failed (transiently)
--   <key>:held       the ingestor is refusing this destination (401/403/404,
--                    or a 400 for the request as a whole); tighter limits apply
-- and: aforo:destinations (every buffer, for the re-arm timer),
-- aforo:instance:<plugin id> (the buffer that plugin instance last used) and
-- aforo:retired:<key> (a buffer whose instance moved on, for a minute).
--
-- Memory (2026-10-13 redesign). There is no byte accounting: counters of what
-- the events occupy drifted -- an entry evicted by someone else's set() left
-- a phantom total behind, and events were refused while the dict was empty.
-- Only ground truth is used: a buffer's length (llen), the dict's free space,
-- and whether a push succeeds. Two facts about the shared dict, checked on
-- Kong 3.4's lua-nginx-module, shape the rules:
--   * rpush / lpush on a full dict fail with "no memory"; they evict nothing.
--   * set() / add() on a full dict evict the least recently used entries --
--     a single 12 KB cache write evicted a whole list of 1,000 events. So no
--     key of this plugin is ever written with set()/add(): every one uses
--     safe_set()/safe_add(), which fail instead. A cache that cannot be
--     written simply misses.

local http = require("resty.http")
local cjson = require("cjson.safe")

local M = {}

local BUFFER_DICT = "aforo_buffer"
local KEY_PREFIX = "aforo:events:"
local DESTINATIONS_KEY = "aforo:destinations"
local INSTANCE_PREFIX = "aforo:instance:"
local RETIRED_PREFIX = "aforo:retired:"

-- Events per buffer. Past it the newest events are dropped.
local MAX_BUFFER_SIZE = 10000

-- A destination the ingestor is refusing keeps far less, and its newest: at
-- most HELD_MAX_EVENTS, none older than the ingestor accepts. A new event
-- for it pushes out its oldest. Kept at all so a key fix loses nothing
-- recent; kept small so a refused destination cannot crowd out the rest.
local HELD_MAX_EVENTS = 500
local HELD_MAX_AGE_SECONDS = 72 * 3600
local HELD_TTL = 86400            -- refreshed on every refusal, cleared on any 2xx

-- The largest event this plugin builds. handler.lua caps every string an
-- event carries (paths 512 characters, trace headers 128-512, identities at
-- the ingestor's limits, names 255); the worst case, every field at its
-- limit in 3-byte characters, is about 13 KiB. Typical events are well under
-- 2 KiB. A larger value is refused, as a guard.
local MAX_EVENT_BYTES = 16384

-- Below this much free space (whole free pages), a push from a healthy
-- destination first evicts the oldest events of refused, then failing,
-- destinations.
local RESERVE_FRACTION = 0.1
local EVICT_BATCH = 16

-- How long a retired buffer redirects pushes to its successor: a worker
-- that has not loaded the new configuration yet still pushes with the old.
local RETIRED_GRACE = 60

-- The ingestor rejects a batch of more than 1000 events with 400, so a
-- backlog (after an outage, say) is drained in slices no larger than this,
-- rather than as one oversized request.
local MAX_BATCH_SIZE = 1000

-- Longest Retry-After (seconds) honoured on a 429 before the next attempt.
-- The flush runs in a timer, so a longer wait would only hold later slices;
-- past this the batch is re-buffered for a later flush instead.
local MAX_RETRY_AFTER_SECONDS = 30

-- One flush stops sending after this long, leaving the rest to the next one.
-- It is checked before every POST, so a flush outlives it by at most one
-- send: three 10 s attempts with two 30 s Retry-After waits (~90 s). The
-- lock outlives budget + one send; it also carries an owner token, so a
-- flush can only ever release its own.
local FLUSH_BUDGET_SECONDS = 60
local FLUSH_LOCK_TTL = 180

local SEND_TIMEOUT_MS = 10000
local SEND_ATTEMPTS = 3
-- Worker exiting (reload / shutdown): one quick try, no retries, no bisection.
local SHUTDOWN_SEND_TIMEOUT_MS = 2000

-- How often worker 0 re-arms flushes for buffers that hold events but have no
-- timer -- after a reload or a crashed worker, when no traffic would do it.
local REARM_INTERVAL = 1

-- The prefix the ingestor puts on a per-event failure that is about storage,
-- not about the event (UsageIngestionServiceImpl.batchErrorMessage: a
-- DataAccessException / TransactionException). Those are worth sending again;
-- every other per-event error is a judgement on the event itself.
local TRANSIENT_EVENT_ERROR = "The event could not be stored"

local function log_throttled(level, key, ttl, ...)
    local dict = ngx.shared[BUFFER_DICT]
    if dict and not dict:safe_add("aforo:warn:" .. key, 1, ttl) then return end
    kong.log[level](...)
end

local function interval_seconds(settings)
    return math.max(0.05, (tonumber(settings.flush_interval_ms) or 5000) / 1000)
end

-- The plugin instance this conf belongs to: Kong sets conf.__plugin_id to
-- the plugin entity's id, which stays the same when the instance's settings
-- change (DB-less included, verified on Kong 3.4). nil if absent.
local function instance_id(conf)
    local id = conf.__plugin_id
    return type(id) == "string" and id ~= "" and id or nil
end

-- One buffer per plugin instance and destination (2026-10-13). It was
-- endpoint + tenant only, so two instances with the same endpoint and tenant
-- but different keys shared one buffer, and each flush sent everybody's
-- events with whichever key was pushed last -- one service's usage under
-- another's (possibly revoked, possibly another tenant's) key. Now nothing
-- is ever mixed: the key and the instance are part of the buffer key.
function M.key(conf)
    return KEY_PREFIX .. ngx.md5((conf.aforo_endpoint or "") .. "\n" .. (conf.tenant_id or "")
        .. "\n" .. ngx.md5(conf.api_key or "") .. "\n" .. (instance_id(conf) or ""))
end

-- ── Delivery settings, shared across workers ─────────────────
--
-- A timer runs in whichever worker scheduled it, long after the request whose
-- settings it saw, so each buffer's settings live in the dict and every
-- flush reads them from there. With the key part of the buffer key, a
-- buffer's settings never change; a new key means a new buffer (see
-- follow_instance).

local function settings_of(conf)
    return {
        aforo_endpoint    = conf.aforo_endpoint,
        api_key           = conf.api_key,
        tenant_id         = conf.tenant_id,
        flush_interval_ms = conf.flush_interval_ms,
        flush_count       = conf.flush_count,
    }
end

local function load_settings(dict, bkey)
    local raw = dict:get(bkey .. ":conf")
    local s = raw and cjson.decode(raw)
    return type(s) == "table" and s or nil
end

local function destinations(dict)
    local list = cjson.decode(dict:get(DESTINATIONS_KEY) or "[]")
    return type(list) == "table" and list or {}
end

-- Buffers, for the re-arm timer and eviction: a JSON list of buffer keys.
-- Read-modify-write under a short lock, only when this buffer is missing; a
-- push that does not get the lock leaves it to the next one.
local function register(dict, bkey)
    local raw = dict:get(DESTINATIONS_KEY)
    if raw and string.find(raw, '"' .. bkey .. '"', 1, true) then return end
    if not dict:safe_add(DESTINATIONS_KEY .. ":lock", true, 1) then return end
    local list = destinations(dict)
    local found = false
    for _, k in ipairs(list) do
        if k == bkey then found = true; break end
    end
    if not found then
        list[#list + 1] = bkey
        dict:safe_set(DESTINATIONS_KEY, cjson.encode(list))
    end
    dict:delete(DESTINATIONS_KEY .. ":lock")
end

local function unregister(dict, bkey)
    if not dict:safe_add(DESTINATIONS_KEY .. ":lock", true, 1) then return end
    local list, keep = destinations(dict), {}
    for _, k in ipairs(list) do
        if k ~= bkey then keep[#keep + 1] = k end
    end
    dict:safe_set(DESTINATIONS_KEY, cjson.encode(keep))
    dict:delete(DESTINATIONS_KEY .. ":lock")
end

local function save_settings(dict, bkey, conf)
    local json = cjson.encode(settings_of(conf))
    if dict:get(bkey .. ":conf") ~= json then
        dict:safe_set(bkey .. ":conf", json)
    end
    register(dict, bkey)
end

-- ── Key rotation, by plugin instance ────────────────────────
--
-- When an instance's api_key (or endpoint / tenant) changes, its buffer key
-- changes too. Its old buffer -- typically events held on 401 while the key
-- was being replaced -- is moved into the new one, so those events go out
-- with the new key, and the old buffer is retired. Only that instance's own
-- buffer moves; no other instance's events are touched. For RETIRED_GRACE a
-- push to the retired buffer (a worker still on the old configuration) is
-- redirected to the new one, so the two cannot keep swapping events.
--
-- Without an instance id (not the case on Kong 3.x) nothing is moved: the
-- old buffer keeps its old key, bounded like any refused destination.

local function retire(dict, old, new)
    local moved, lost = 0, 0
    while true do
        -- Newest of the old buffer first, each to the head of the new one:
        -- the old events end up in front, in order.
        local item = dict:rpop(old)
        if not item then break end
        if dict:lpush(new, item) then
            moved = moved + 1
        else
            lost = lost + 1
        end
    end
    dict:safe_set(RETIRED_PREFIX .. old, new, RETIRED_GRACE)
    for _, suffix in ipairs({ ":conf", ":held", ":failing", ":backoff", ":pending", ":kick" }) do
        dict:delete(old .. suffix)
    end
    unregister(dict, old)
    return moved, lost
end

-- The buffer this push goes to, and whether conf is its own (false: a
-- redirect from a retired buffer, whose successor has its own settings).
local function follow_instance(dict, conf)
    local bkey = M.key(conf)
    local inst = instance_id(conf)
    if not inst then return bkey, true end

    local successor = dict:get(RETIRED_PREFIX .. bkey)
    if successor then return successor, false end

    local ikey = INSTANCE_PREFIX .. inst
    local prev = dict:get(ikey)
    if prev ~= bkey then
        if prev and dict:safe_add(prev .. ":migrating", true, 30) then
            local moved, lost = retire(dict, prev, bkey)
            dict:delete(prev .. ":migrating")
            if moved > 0 or lost > 0 then
                kong.log.warn("[aforo-metering] The settings of plugin ", inst, " changed (",
                    "api_key, aforo_endpoint or tenant_id): ", moved, " buffered event(s) will go out ",
                    "with the new settings", lost > 0 and (", " .. lost .. " lost: shared dict full") or "", ".")
            end
        end
        dict:safe_set(ikey, bkey)
    end
    return bkey, true
end

-- ── Memory ──────────────────────────────────────────────────

local function reserve(dict)
    return math.max(dict:capacity() * RESERVE_FRACTION, 4 * MAX_EVENT_BYTES)
end

-- Days-from-civil: a UTC calendar time as epoch seconds, without os.time
-- (which is local time).
local function utc_epoch(y, m, d, hh, mm, ss)
    y = y - ((m <= 2) and 1 or 0)
    local era = math.floor(y / 400)
    local yoe = y - era * 400
    local doy = math.floor((153 * ((m + 9) % 12) + 2) / 5) + d - 1
    local doe = yoe * 365 + math.floor(yoe / 4) - math.floor(yoe / 100) + doy
    return (era * 146097 + doe - 719468) * 86400 + hh * 3600 + mm * 60 + ss
end

-- An encoded event's occurredAt, as epoch seconds (nil if unreadable).
local function occurred_at(encoded)
    local y, m, d, hh, mm, ss = string.match(encoded,
        '"occurredAt":"(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)')
    if not y then return nil end
    return utc_epoch(tonumber(y), tonumber(m), tonumber(d), tonumber(hh), tonumber(mm), tonumber(ss))
end

-- Take up to `max` events off the head of the buffer. Each lpop is atomic, so
-- concurrent flushes in different workers take disjoint events: nothing is sent
-- twice and nothing is lost between a read and a delete.
local function pop_batch(dict, bkey, max)
    local batch = {}
    for i = 1, max do
        local item, err = dict:lpop(bkey)
        if not item then
            if err then
                kong.log.err("[aforo-metering] Could not read buffer: ", err)
            end
            break
        end
        batch[i] = item
    end
    return batch
end

-- Drop n events from one end of a buffer ("head" = oldest, "tail" = newest).
local function drop(dict, bkey, n, from)
    local dropped = 0
    for _ = 1, n do
        local item = (from == "head") and dict:lpop(bkey) or dict:rpop(bkey)
        if not item then break end
        dropped = dropped + 1
    end
    return dropped
end

-- Make room by evicting the oldest events of other buffers: refused (held)
-- ones first, then ones whose last flush failed. Never except_bkey's own.
-- Returns how many events went.
local function evict_failing(dict, except_bkey, n)
    local list = destinations(dict)
    local evicted = 0
    for _, marker in ipairs({ ":held", ":failing" }) do
        for _, bkey in ipairs(list) do
            if evicted >= n then break end
            if bkey ~= except_bkey and dict:get(bkey .. marker) then
                evicted = evicted + drop(dict, bkey, n - evicted, "head")
            end
        end
    end
    if evicted > 0 then
        log_throttled("warn", "evict_failing", 10, "[aforo-metering] Shared dict '", BUFFER_DICT,
            "' is nearly full: dropped the oldest ", evicted, " event(s) of destinations the ingestor ",
            "is refusing or failing, to keep metering the others. Repeats suppressed for 10s.")
    end
    return evicted
end

-- Put events back at the head of the buffer, oldest first, under the same
-- rules as a push. Returns how many events were dropped.
--
-- Normally the OLDEST are kept: they are the ones closest to falling outside
-- the ingestor's acceptance window, and recent events are recoverable from
-- upstream logs far more often than old ones. A held destination keeps its
-- NEWEST instead, within HELD_MAX_AGE_SECONDS: its oldest are the ones about
-- to become undeliverable. Out of memory, a buffer that is not held may evict
-- refused or failing destinations' oldest events; a held one evicts nobody.
local function rebuffer(dict, bkey, batch, held)
    local dropped = 0
    local oldest_ok = held and (ngx.now() - HELD_MAX_AGE_SECONDS) or nil
    local first = 1
    if held then
        -- Only as many as fit, and those the newest of the batch.
        local room = math.max(0, HELD_MAX_EVENTS - (dict:llen(bkey) or 0))
        if #batch > room then
            first = #batch - room + 1
            dropped = dropped + first - 1
        end
    end
    for i = #batch, first, -1 do
        local item = batch[i]
        local t = oldest_ok and occurred_at(item)
        if t and t < oldest_ok then
            dropped = dropped + 1
        else
            local ok = dict:lpush(bkey, item)
            if not ok and not held and evict_failing(dict, bkey, EVICT_BATCH) > 0 then
                ok = dict:lpush(bkey, item)
            end
            if not ok then dropped = dropped + 1 end
        end
    end

    local limit = held and HELD_MAX_EVENTS or MAX_BUFFER_SIZE
    local len = dict:llen(bkey) or 0
    if len > limit then
        dropped = dropped + drop(dict, bkey, len - limit, held and "head" or "tail")
    end
    return dropped
end

-- A 2xx can still carry per-event failures: /v1/ingest/batch answers 202
-- with {accepted, duplicates, failed, errors = [{index, message}]}. They used
-- to be ignored, so an event the ingestor could not store was gone. Returns
-- the events to send again (storage trouble); every other per-event error is
-- logged and not retried, since resending the same event gets the same answer.
local function per_event_retries(batch, body)
    local resp = cjson.decode(body or "")
    if type(resp) ~= "table" or type(resp.errors) ~= "table" then return {} end

    local retry, rejected = {}, {}
    for _, e in ipairs(resp.errors) do
        local idx = type(e) == "table" and tonumber(e.index)
        local event = idx and batch[idx + 1]
        if event then
            local msg = type(e.message) == "string" and e.message or "no reason given"
            if string.sub(msg, 1, #TRANSIENT_EVENT_ERROR) == TRANSIENT_EVENT_ERROR then
                retry[#retry + 1] = event
            else
                rejected[#rejected + 1] = msg
            end
        end
    end

    if #rejected > 0 then
        local sample = {}
        for i = 1, math.min(3, #rejected) do sample[i] = rejected[i] end
        log_throttled("err", "ingest_event_rejected", 60,
            "[aforo-metering] The ingestor rejected ", #rejected, " of ", #batch,
            " event(s) in a batch; they are not retried. First reasons: ",
            table.concat(sample, " | "), ". Repeats suppressed for 60s.")
    end
    if #retry > 0 then
        log_throttled("warn", "ingest_event_retry", 60,
            "[aforo-metering] The ingestor could not store ", #retry, " of ", #batch,
            " event(s); they are kept and sent again. Repeats suppressed for 60s.")
    end
    return retry
end

-- POST one batch. Returns:
--   "sent", retry   2xx; retry = events the ingestor could not store this time
--   "split"         400 or 413 on a batch of several events: try it in halves
--   "rejected"      permanent refusal (the events are dropped, and logged)
--   "held"          401 / 403 / 404: keep, under the held limits
--   "failed"        transient (5xx, timeout, 408, 429): keep and retry
local function send_batch(settings, batch, timeout_ms, attempts)
    local httpc = http.new()
    httpc:set_timeout(timeout_ms)

    -- Each element is already a JSON-encoded event, so the body is assembled
    -- rather than decoded and re-encoded: cheaper, and the bytes sent are
    -- exactly the bytes buffered.
    local body = '{"events":[' .. table.concat(batch, ",") .. ']}'

    for attempt = 1, attempts do
        local res, err = httpc:request_uri(settings.aforo_endpoint, {
            method  = "POST",
            body    = body,
            -- X-API-Key, not Authorization: Bearer (2026-09-03).
            --
            -- The ingestor authenticates keys through aforo-common's
            -- ApiKeyAuthFilter, which reads X-API-Key and nothing else. A key sent
            -- as a Bearer token is simply not seen: the request stays anonymous and
            -- /v1/ingest/batch answers 403 "You don't have permission to
            -- usage-events:ingest", which reads like a permissions problem on the
            -- key rather than a header the server never looked at.
            --
            -- Sent ALONE. Adding Authorization: Bearer alongside as a fallback was
            -- tried and is actively harmful: an API key in that header is parsed as
            -- a JWT, fails, and the request is rejected 401 before the API-key
            -- filter ever runs. Verified against production -- X-API-Key alone
            -- returns 202, the two together return 401.
            headers = {
                ["Content-Type"]  = "application/json",
                ["X-API-Key"]     = settings.api_key or "",
                ["X-Tenant-Id"]   = settings.tenant_id or "",
            },
        })

        if res and res.status >= 200 and res.status < 300 then
            kong.log.info("[aforo-metering] Flushed ", #batch, " events to Aforo (status=", res.status, ")")
            return "sent", per_event_retries(batch, res.body)
        end

        local status = res and res.status or nil
        local resp_body = res and string.sub(tostring(res.body or ""), 1, 500) or ""
        kong.log.warn("[aforo-metering] Flush attempt ", attempt, "/", attempts,
            " failed (status=", status or "no response", ", err=", err or "none", ")")

        -- Name the fix for the one failure that is reliably misdiagnosed.
        -- OpenSSL error 20 against an https endpoint almost always means Kong's
        -- lua_ssl_verify_depth (default 1) is too shallow for the chain, NOT a
        -- missing CA bundle -- so operators go install certificates that are
        -- already there. Only logged on the final attempt to avoid noise.
        if attempt == attempts and err and string.find(err, "unable to get local issuer certificate", 1, true) then
            kong.log.err("[aforo-metering] TLS verification failed for ", settings.aforo_endpoint, ". ",
                "This is usually lua_ssl_verify_depth, which Kong defaults to 1 -- too shallow for a ",
                "leaf/intermediate/root chain. Set lua_ssl_verify_depth = 3 in kong.conf (or ",
                "KONG_LUA_SSL_VERIFY_DEPTH=3). Adding CA certificates will not help: Kong already ",
                "trusts the system bundle via lua_ssl_trusted_certificate.")
        end

        -- 401 / 403 / 404: a rotated or revoked key, a key without
        -- usage-events:ingest, or a wrong aforo_endpoint. Not the events'
        -- fault, and nothing a retry in the next second fixes -- but the
        -- operator can fix it, and the most recent events should still be
        -- here when they do. Kept under the held limits; the log says so.
        if status == 401 or status == 403 or status == 404 then
            log_throttled("err", "ingest_auth_" .. status, 60,
                "[aforo-metering] The ingestor answered ", status, " for ", settings.aforo_endpoint,
                " -- check api_key, its usage-events:ingest permission, tenant_id and ",
                "aforo_endpoint. The newest ", HELD_MAX_EVENTS, " events (none older than 72 h) are ",
                "KEPT and retried every flush_interval_ms. Response: ",
                resp_body, ". Repeats suppressed for 60s.")
            return "held"
        end

        -- 400: the ingestor could not read the batch (one malformed event
        -- fails the whole request -- non-UTF-8 bytes are the classic). 413:
        -- too big for the ingestor or a proxy in front of it. Either way,
        -- halves may well pass: the caller bisects, so one bad event costs
        -- only itself and an oversized batch goes out in smaller parts. A
        -- single event that still gets 400 or 413 is dropped, with the reason.
        if status == 400 or status == 413 then
            if #batch > 1 then return "split", resp_body, status end
            log_throttled("err", "ingest_rejected_event_" .. status, 60,
                "[aforo-metering] The ingestor rejected an event with ", status,
                status == 413 and " (too large for the ingestor or a proxy in front of it)" or "",
                " -- dropping it. Response: ", resp_body, ". Repeats suppressed for 60s.")
            return "rejected"
        end

        -- Any other 4xx except 408 / 429: the ingestor understood the batch and
        -- refused it; retrying sends the same bytes to the same judgement.
        if status and status >= 400 and status < 500 and status ~= 408 and status ~= 429 then
            kong.log.err("[aforo-metering] Ingestor rejected the batch with ", status,
                " -- dropping ", #batch, " event(s) rather than retrying them forever. ",
                "Response: ", resp_body)
            return "rejected"
        end

        if attempt < attempts then
            local wait = math.pow(2, attempt - 1)
            -- Honour the ingestor's Retry-After on 429 (delta-seconds form).
            -- Longer than MAX_RETRY_AFTER_SECONDS: stop here and let the
            -- caller re-buffer, rather than sleep through the flush.
            if status == 429 then
                local ra = res.headers and tonumber(res.headers["Retry-After"]
                    or res.headers["retry-after"])
                if ra and ra >= 0 then
                    if ra > MAX_RETRY_AFTER_SECONDS then
                        break
                    end
                    wait = ra
                end
            end
            ngx.sleep(wait)
        end
    end

    return "failed"
end

local function slice(list, from, to)
    local out = {}
    for i = from, to do out[#out + 1] = list[i] end
    return out
end

local function append(into, list)
    for _, e in ipairs(list) do into[#into + 1] = e end
    return into
end

-- The flush's time budget, checked before every POST -- not only between
-- slices: one bisected slice can otherwise run for many minutes.
local function over_budget(ctx)
    if ngx.now() - ctx.started > FLUSH_BUDGET_SECONDS then
        ctx.stop = true
        return true
    end
    return false
end

-- Send events, bisecting on 400 / 413. Returns the events to keep.
-- ctx: settings, started, timeout_ms, attempts, no_split; set here: stop,
-- held, failed, got_2xx. A known (outcome, retry, status) for these events
-- may be passed in.
local deliver
deliver = function(ctx, events, depth, outcome, retry, status)
    if ctx.stop then return events end
    if not outcome then
        if over_budget(ctx) then return events end
        outcome, retry, status = send_batch(ctx.settings, events, ctx.timeout_ms, ctx.attempts)
    end

    if outcome == "sent" then
        ctx.got_2xx = true
        if #retry > 0 then ctx.stop, ctx.failed = true, true end
        return retry
    elseif outcome == "rejected" then
        return {}
    elseif outcome == "held" then
        ctx.stop, ctx.held = true, true
        return events
    elseif outcome == "failed" then
        ctx.stop, ctx.failed = true, true
        return events
    end

    -- "split" (400 or 413 on several events)
    if ctx.no_split then
        ctx.stop, ctx.failed = true, true
        return events
    end
    local mid = math.floor(#events / 2)
    local left, right = slice(events, 1, mid), slice(events, mid + 1, #events)

    if depth == 0 and status == 400 then
        -- If both halves of the first split are refused with 400 too, it is
        -- not an event: it is the request -- a wrong aforo_endpoint path, a
        -- WAF in front of the ingestor. Bisecting further cost 2n-1 POSTs per
        -- flush. Stop, and keep the events as for a 404. Only for 400: a 413
        -- means "too big", and smaller parts are exactly the answer -- they
        -- are bisected down to single events (2026-10-13 fix: a 413 that
        -- also refused both halves used to hold the destination for good).
        if over_budget(ctx) then return events end
        local lo, lr, ls = send_batch(ctx.settings, left, ctx.timeout_ms, ctx.attempts)
        if lo == "split" and ls == 400 then
            if over_budget(ctx) then return events end
            local ro, rr, rs = send_batch(ctx.settings, right, ctx.timeout_ms, ctx.attempts)
            if ro == "split" and rs == 400 then
                log_throttled("err", "ingest_request_400", 60,
                    "[aforo-metering] The ingestor answers 400 to every part of the batch, so the ",
                    "request itself is refused, not an event -- check aforo_endpoint and anything ",
                    "in front of the ingestor. Events are kept under the same limits as for 404. ",
                    "Response: ", tostring(rr or lr), ". Repeats suppressed for 60s.")
                ctx.stop, ctx.held = true, true
                return events
            end
            local keep = deliver(ctx, left, depth + 1, lo, lr, ls)
            return append(keep, deliver(ctx, right, depth + 1, ro, rr, rs))
        end
        local keep = deliver(ctx, left, depth + 1, lo, lr, ls)
        return append(keep, deliver(ctx, right, depth + 1))
    end

    local keep = deliver(ctx, left, depth + 1)
    return append(keep, deliver(ctx, right, depth + 1))
end

local flush_timer

-- A timed flush is always pending while this buffer holds events: one per
-- buffer across all workers, claimed with safe_add(). The TTL is a safety
-- net for a timer lost with its worker; the re-arm timer (init_worker) and
-- the next push then schedule a new one.
local function ensure_pending(dict, bkey, settings)
    local interval = interval_seconds(settings)
    if dict:safe_add(bkey .. ":pending", true, interval + 10) then
        local ok, err = ngx.timer.at(interval, flush_timer, bkey, false)
        if not ok then
            dict:delete(bkey .. ":pending")
            kong.log.warn("[aforo-metering] Failed to schedule timed flush: ", err)
        end
    end
end

local function drain(dict, bkey, settings)
    local ctx = { settings = settings, started = ngx.now(),
                  timeout_ms = SEND_TIMEOUT_MS, attempts = SEND_ATTEMPTS }
    for _ = 1, math.ceil(MAX_BUFFER_SIZE / MAX_BATCH_SIZE) do
        local batch = pop_batch(dict, bkey, MAX_BATCH_SIZE)
        if #batch == 0 then break end

        local keep = deliver(ctx, batch, 0)

        -- The destination works again as soon as anything got a 2xx -- also a
        -- 202 that reports a transient per-event error (2026-10-13 fix).
        if ctx.held then
            dict:safe_set(bkey .. ":held", true, HELD_TTL)
        elseif ctx.got_2xx then
            dict:delete(bkey .. ":held")
        end

        if #keep > 0 then
            -- Re-buffer what was not delivered (2026-09-01 fix). The events were
            -- taken off the buffer before the first attempt, so an ingestor
            -- outage outlasting the retries used to destroy the only copy of
            -- them: unbilled usage, no dead-letter, nothing to reconstruct from.
            local dropped = rebuffer(dict, bkey, keep, ctx.held)
            local what = ctx.held and "refused" or "failed"
            if dropped > 0 then
                -- Never throttled: these events are gone.
                kong.log.err("[aforo-metering] Delivery to ", settings.aforo_endpoint, " ", what,
                    ": ", #keep - dropped, " event(s) kept, ", dropped, " dropped (",
                    ctx.held and ("over " .. HELD_MAX_EVENTS .. " events, older than 72 h, or no memory")
                        or "the buffer or the shared dict is full", ").")
            elseif ctx.held or ctx.failed then
                -- Once a minute per destination: a refused or failing
                -- destination is retried every flush_interval_ms, and one line
                -- per retry buried everything else in the log.
                log_throttled("err", what .. "_" .. bkey, 60, "[aforo-metering] Delivery to ",
                    settings.aforo_endpoint, " ", what, ": ", #keep, " event(s) kept for retry. ",
                    "Repeats suppressed for 60s.")
            end
        end

        if ctx.stop then
            if ctx.held or ctx.failed then
                -- Back off: no immediate flush until flush_interval_ms has
                -- passed. Without it, every request past flush_count started
                -- another flush against an ingestor that was already failing.
                dict:safe_set(bkey .. ":backoff", true, interval_seconds(settings))
                dict:safe_set(bkey .. ":failing", true, interval_seconds(settings) * 3 + 10)
            end
            return
        end
        dict:delete(bkey .. ":failing")
        if #batch < MAX_BATCH_SIZE then return end
    end
end

-- Worker exiting (kong reload, or a graceful stop): timers run once more with
-- premature = true. One quick best-effort send, no retries, no bisection;
-- what does not go out is put back (the dict survives a reload). The
-- :pending / :kick markers go too: they stood for timers that die with this
-- worker, and left in place they kept the new workers from re-arming.
local function shutdown_send(dict, bkey, settings)
    local batch = pop_batch(dict, bkey, MAX_BATCH_SIZE)
    if #batch == 0 then return end
    local ctx = { settings = settings, started = ngx.now(), no_split = true,
                  timeout_ms = SHUTDOWN_SEND_TIMEOUT_MS, attempts = 1 }
    local keep = deliver(ctx, batch, 0)
    if #keep > 0 then
        local dropped = rebuffer(dict, bkey, keep, ctx.held or dict:get(bkey .. ":held"))
        if dropped > 0 then
            kong.log.err("[aforo-metering] Shutdown flush to ", settings.aforo_endpoint, ": ",
                dropped, " event(s) dropped putting the rest back.")
        end
    end
end

flush_timer = function(premature, bkey, immediate)
    local dict = ngx.shared[BUFFER_DICT]
    if not dict then
        kong.log.err("[aforo-metering] Shared dict '", BUFFER_DICT, "' not found")
        return
    end

    local settings = load_settings(dict, bkey)
    if premature then
        dict:delete(bkey .. ":pending")
        dict:delete(bkey .. ":kick")
        if settings then
            local ok, err = pcall(shutdown_send, dict, bkey, settings)
            if not ok then kong.log.err("[aforo-metering] Shutdown flush failed: ", tostring(err)) end
        end
        return
    end

    if not immediate then dict:delete(bkey .. ":pending") end
    if not settings then
        -- A retired buffer (its instance moved on) has none, and is empty.
        if (dict:llen(bkey) or 0) > 0 then
            log_throttled("err", "no_settings", 60, "[aforo-metering] No delivery settings for a ",
                "buffer -- its events wait for the next request to that destination. Repeats ",
                "suppressed for 60s.")
        end
        if immediate then dict:delete(bkey .. ":kick") end
        return
    end

    -- At most one flush per buffer at a time, across workers. The token makes
    -- sure a flush only ever releases its own lock.
    local token = tostring(ngx.worker.pid()) .. ":" .. tostring(ngx.now()) .. ":" .. tostring(math.random(1e9))
    if dict:safe_add(bkey .. ":lock", token, FLUSH_LOCK_TTL) then
        local ok, err = pcall(drain, dict, bkey, settings)
        if dict:get(bkey .. ":lock") == token then dict:delete(bkey .. ":lock") end
        if not ok then kong.log.err("[aforo-metering] Flush failed: ", tostring(err)) end
    end
    if immediate then dict:delete(bkey .. ":kick") end

    if (dict:llen(bkey) or 0) > 0 then
        ensure_pending(dict, bkey, settings)
    end
end

-- Make sure a flush is coming, without piling up timers: the timed one (see
-- ensure_pending), plus one immediate flush once flush_count events wait --
-- unless a flush is already running or the last one failed recently.
local function schedule(dict, bkey, settings, count)
    ensure_pending(dict, bkey, settings)
    if count >= (tonumber(settings.flush_count) or 50)
        and not dict:get(bkey .. ":lock")
        and not dict:get(bkey .. ":backoff")
        and dict:safe_add(bkey .. ":kick", true, FLUSH_LOCK_TTL) then
        local ok, err = ngx.timer.at(0, flush_timer, bkey, true)
        if not ok then
            dict:delete(bkey .. ":kick")
            kong.log.warn("[aforo-metering] Failed to schedule immediate flush: ", err)
        end
    end
end

-- Buffer one encoded event. Returns true when it was buffered.
function M.push(conf, encoded)
    local dict = ngx.shared[BUFFER_DICT]
    if not dict then
        kong.log.err("[aforo-metering] Shared dict '", BUFFER_DICT, "' not available. ",
            "Add 'lua_shared_dict aforo_buffer 10m;' to kong.conf")
        return false
    end
    if #encoded > MAX_EVENT_BYTES then
        log_throttled("err", "event_too_large", 60, "[aforo-metering] Not buffering an event of ",
            #encoded, " bytes (the limit is ", MAX_EVENT_BYTES, "). Repeats suppressed for 60s.")
        return false
    end

    local bkey, own = follow_instance(dict, conf)
    local settings
    if own then
        save_settings(dict, bkey, conf)
        settings = settings_of(conf)
    else
        settings = load_settings(dict, bkey) or settings_of(conf)
    end

    local held = dict:get(bkey .. ":held")
    local count = dict:llen(bkey) or 0
    if held then
        -- Refused: keep the newest -- a new event pushes out the oldest.
        if count >= HELD_MAX_EVENTS then
            drop(dict, bkey, count - HELD_MAX_EVENTS + 1, "head")
            log_throttled("warn", "buffer_full_held", 10, "[aforo-metering] ", settings.aforo_endpoint,
                " is refusing this plugin's events (401/403/404, or 400 for every request), and it ",
                "keeps only its newest ", HELD_MAX_EVENTS, ": dropping the oldest. Fix api_key / ",
                "aforo_endpoint; see the flush errors. Repeats suppressed for 10s.")
        end
    elseif count >= MAX_BUFFER_SIZE then
        log_throttled("warn", "buffer_full", 10, "[aforo-metering] Buffer full for ",
            settings.aforo_endpoint, " (", count, " events) -- dropping the newest event. The ",
            "ingestor is failing or unreachable; see the flush errors. Repeats suppressed for 10s.")
        -- Keep a flush coming: a full buffer must still drain once the
        -- ingestor recovers.
        schedule(dict, bkey, settings, count)
        return false
    end

    -- A refused or failing destination must never cost a healthy one its
    -- events: when the dict runs low, a healthy push first evicts their
    -- oldest events. A refused or failing destination evicts nobody.
    local healthy = not held and not dict:get(bkey .. ":failing")
    if healthy and dict:free_space() < reserve(dict) then
        evict_failing(dict, bkey, EVICT_BATCH)
    end
    local n, push_err = dict:rpush(bkey, encoded)
    if not n and healthy and evict_failing(dict, bkey, EVICT_BATCH * 4) > 0 then
        n, push_err = dict:rpush(bkey, encoded)
    end
    if not n then
        log_throttled("err", "dict_full", 10, "[aforo-metering] Could not buffer an event: ",
            "shared dict '", BUFFER_DICT, "' is full (", tostring(push_err), "). The ingestor is ",
            "failing or unreachable -- see the flush errors -- or the dict is small for this ",
            "traffic: raise lua_shared_dict ", BUFFER_DICT, ". Event not metered. Repeats suppressed for 10s.")
        schedule(dict, bkey, settings, count)
        return false
    end
    schedule(dict, bkey, settings, n)
    return true
end

-- Re-arm flushes for every buffer that holds events (runs on worker 0). After
-- a kong reload, or a worker that crashed, buffered events used to wait until
-- new traffic arrived for their destination -- possibly never.
local function rearm(premature)
    if premature then return end
    local dict = ngx.shared[BUFFER_DICT]
    if not dict then return end
    for _, bkey in ipairs(destinations(dict)) do
        if (dict:llen(bkey) or 0) > 0 then
            local settings = load_settings(dict, bkey)
            if settings then ensure_pending(dict, bkey, settings) end
        end
    end
end

function M.init_worker()
    if ngx.worker.id() ~= 0 then return end
    local ok, err = ngx.timer.every(REARM_INTERVAL, rearm)
    if not ok then
        kong.log.err("[aforo-metering] Could not start the flush re-arm timer: ", err)
    end
end

-- For tests and handler.lua's export: flush the buffer of this conf's
-- destination now, with conf as its current settings.
function M.flush(premature, conf, immediate)
    local dict = ngx.shared[BUFFER_DICT]
    local bkey = M.key(conf)
    if dict then
        local own
        bkey, own = follow_instance(dict, conf)
        if own then save_settings(dict, bkey, conf) end
    end
    return flush_timer(premature, bkey, immediate)
end

M.MAX_BUFFER_SIZE = MAX_BUFFER_SIZE
M.HELD_MAX_EVENTS = HELD_MAX_EVENTS
M.MAX_EVENT_BYTES = MAX_EVENT_BYTES
M._rearm = rearm

return M
