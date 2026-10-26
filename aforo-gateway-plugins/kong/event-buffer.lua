-- Aforo event buffer and delivery for Kong Gateway.
--
-- handler.lua's log phase hands each JSON-encoded event to M.push(conf, json).
-- Timers drain the buffer to the ingestor's batch endpoint (aforo_endpoint).
-- Nothing here runs on the request path except the push and the scheduling
-- checks next to it.
--
-- Shared memory: the aforo_buffer dict (lua_shared_dict aforo_buffer 10m).
-- One buffer per destination: aforo_endpoint + tenant_id + api_key (hashed).
-- A buffer is only ever delivered with its own endpoint, tenant and key, and
-- events never move between buffers -- not when a plugin's settings change
-- either: events taken under one key are delivered with that key or not at
-- all. Per buffer the dict holds:
--   <key>            the events, a list, one encoded event per element
--   <key>:conf       the buffer's delivery settings (TTL CONF_TTL, refreshed
--                    by pushes; it outlives every event the buffer can hold)
--   <key>:lock       a flush is running (at most one per buffer, all workers)
--   <key>:pending    a timed flush is scheduled
--   <key>:kick       an immediate (flush_count) flush is scheduled
--   <key>:backoff    no immediate flush until it expires (after a failure)
--   <key>:failing    a delivery attempt failed and no 2xx has come since
--   <key>:held       the ingestor is refusing this destination (401/403/404,
--                    or a 400 for the request as a whole); tighter limits apply
--   <key>:held_n     consecutive refused flushes, for the retry back-off
--   <key>:reg        this buffer is in the registry (TTL follows :conf)
-- and aforo:registry, a list of every buffer, for the re-arm timer and
-- eviction.
--
-- Memory: there is no byte accounting -- counters of what the events occupy
-- drift. Only ground truth is used: a buffer's length (llen), the dict's free
-- space, and whether a push succeeds. On Kong 3.4's lua-nginx-module, rpush /
-- lpush on a full dict fail with "no memory" and evict nothing, while set() /
-- add() evict the least recently used entries -- one 12 KB cache write
-- evicted a whole list of 1,000 events. So no key of this plugin is ever
-- written with set()/add(): every write uses safe_set()/safe_add(), which
-- fail instead. A cache that cannot be written simply misses.

local http = require("resty.http")
local cjson = require("cjson.safe")

-- record_drop lives in event-util.lua (installed path first, source tree second).
local event_util
do
    local ok, mod = pcall(require, "kong.plugins.aforo-metering.event-util")
    event_util = ok and mod or require("event-util")
end
local record_drop = event_util.record_drop

local M = {}

local BUFFER_DICT = "aforo_buffer"
local KEY_PREFIX = "aforo:events:"
-- A list, one buffer key per element (2026-10-13). It was one JSON string,
-- rewritten whenever a destination was added. On a full dict, safe_set of an
-- existing key whose new value falls into another slab size class frees the
-- old value and then fails -- so growing the string past a size class (the
-- 4th, 9th, 20th, 41st... destination) deleted the whole registry, and with
-- it eviction and re-arm. A list grows one small element at a time and is
-- never rewritten.
local REGISTRY_KEY = "aforo:registry"

-- Events per buffer. Past it the newest events are dropped.
local MAX_BUFFER_SIZE = 10000

-- The ingestor accepts no event older than this, so none is kept longer:
-- older events are dropped (and logged) when a flush finds them.
local MAX_EVENT_AGE_SECONDS = 72 * 3600

-- A buffer's settings live this long after the last push. Longer than any
-- event can stay (MAX_EVENT_AGE_SECONDS), so a buffer that holds events
-- always has the settings to deliver them: it can never strand.
local CONF_TTL = MAX_EVENT_AGE_SECONDS + 3 * 3600
local CONF_REFRESH = 3600         -- a push re-extends the TTL at most hourly

-- A destination the ingestor is refusing keeps far less, and its newest: at
-- most HELD_MAX_EVENTS. A new event for it pushes out its oldest. It is
-- retried with its own settings at flush_interval_ms x 2^n (n = refused
-- flushes in a row), at most every HELD_MAX_BACKOFF seconds, until a 2xx.
local HELD_MAX_EVENTS = 500
local HELD_MAX_BACKOFF = 300
local HELD_TTL = 86400            -- refreshed on every refusal, cleared on any 2xx

-- The largest event this plugin builds. handler.lua caps every string an
-- event carries (paths 512 characters, trace headers 128-512, identities at
-- the ingestor's limits, names 255); the worst case, every field at its
-- limit in 3-byte characters, is about 13 KiB. Typical events are well under
-- 2 KiB. A larger value is refused, as a guard.
local MAX_EVENT_BYTES = 16384

-- Below this much free space (whole free pages), a push from a healthy
-- destination first evicts the oldest events of refused, then failing,
-- destinations -- and keeps evicting until it fits, while there are any.
local RESERVE_FRACTION = 0.1
local EVICT_BATCH = 16

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

-- :failing lasts at least as long as a failing flush can run plus the longest
-- wait before the next one, and is refreshed by every failed attempt; only a
-- 2xx clears it. (It used to expire after 25 s -- shorter than one failing
-- flush -- so a healthy destination could be refused on a full dict while a
-- failing one still held evictable events.)
local FAILING_TTL = FLUSH_LOCK_TTL + HELD_MAX_BACKOFF + 60

local SEND_TIMEOUT_MS = 10000
local SEND_ATTEMPTS = 3
-- Worker exiting (reload / shutdown): one quick try, no retries, no bisection.
local SHUTDOWN_SEND_TIMEOUT_MS = 2000

-- How often worker 0 re-arms flushes for buffers that hold events but have no
-- timer -- after a reload or a crashed worker, when no traffic would do it --
-- and prunes the registry.
local REARM_INTERVAL = 1
local MAX_DESTINATIONS = 512

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

-- One buffer per destination: endpoint + tenant + key. Two plugin instances
-- with different keys never share a buffer, so neither is ever delivered with
-- the other's key. The plugin's own id is deliberately not part of it: in
-- DB-less mode a plugin on an unnamed route or service gets a new id on every
-- configuration load, which would orphan its buffer on each reload.
function M.key(conf)
    return KEY_PREFIX .. ngx.md5((conf.aforo_endpoint or "") .. "\n" .. (conf.tenant_id or "")
        .. "\n" .. ngx.md5(conf.api_key or ""))
end

-- ── Delivery settings, shared across workers ─────────────────
--
-- A timer runs in whichever worker scheduled it, long after the request whose
-- settings it saw, so each buffer's settings live in the dict and every
-- flush reads them from there. With the key part of the buffer key, a
-- buffer's settings never change; a new key is a new buffer.

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

-- Add this buffer to the registry, once: the :reg marker (safe_add)
-- deduplicates, and one rpush adds it. A failed rpush loses at most this one
-- entry; the marker goes with it, so the buffer's next push tries again.
local function register(dict, bkey)
    if dict:get(bkey .. ":reg") then return end
    if (dict:llen(REGISTRY_KEY) or 0) >= MAX_DESTINATIONS then
        log_throttled("err", "registry_full", 300, "[aforo-metering] More than ", MAX_DESTINATIONS,
            " destinations (aforo_endpoint + tenant_id + api_key) are buffering at once; a new one ",
            "is still delivered, but not re-armed after a reload. Repeats suppressed for 300s.")
        return
    end
    if not dict:safe_add(bkey .. ":reg", true, CONF_TTL) then return end
    local ok, err = dict:rpush(REGISTRY_KEY, bkey)
    if not ok then
        dict:delete(bkey .. ":reg")
        log_throttled("warn", "registry_push", 60, "[aforo-metering] Could not add a destination to ",
            "the registry (", tostring(err), "); retried on its next push. Repeats suppressed for 60s.")
    end
end

-- Visit every registered buffer: a list cannot be read without taking from
-- it, so each entry is popped and pushed back. visit(bkey) returning false
-- removes the entry (and its markers); returning "stop" ends the walk. An
-- entry added meanwhile by another worker is simply visited or not. A
-- failed push-back loses that one entry: its :reg marker is deleted so the
-- buffer's next push registers it again.
local function each_destination(dict, visit)
    local n = dict:llen(REGISTRY_KEY) or 0
    for _ = 1, n do
        local bkey = dict:lpop(REGISTRY_KEY)
        if not bkey then break end
        local verdict = visit(bkey)
        if verdict == false then
            for _, suffix in ipairs({ ":reg", ":held", ":held_n", ":failing", ":backoff" }) do
                dict:delete(bkey .. suffix)
            end
        else
            if not dict:rpush(REGISTRY_KEY, bkey) then
                dict:delete(bkey .. ":reg")
                log_throttled("warn", "registry_push", 60, "[aforo-metering] Could not keep a ",
                    "destination in the registry (no memory); retried on its next push. Repeats ",
                    "suppressed for 60s.")
            end
            if verdict == "stop" then break end
        end
    end
end

-- Record this buffer's settings and keep them alive as long as its events.
-- Returns whether the buffer has settings now: a buffer without them must
-- never take an event (it could never be delivered).
--
-- Rewritten only when needed: endpoint, tenant and key are the buffer's key,
-- so two confs for one buffer can differ only in flush_interval_ms /
-- flush_count -- two plugin instances sharing a destination. The rule: the
-- settings in the dict stay; a push re-asserts its own flush settings only
-- when the entry is due for its hourly TTL refresh. So two such instances
-- take turns at most hourly, never per push, and a changed flush setting
-- takes effect within the hour. A rewrite that fails (on a full dict a value
-- of another size class frees the old one and then fails) restores the
-- previous value, whose freed slot fits it.
local function save_settings(dict, bkey, conf)
    local ckey = bkey .. ":conf"
    local cur = dict:get(ckey)
    if not cur then
        dict:safe_set(ckey, cjson.encode(settings_of(conf)), CONF_TTL)
    else
        local ttl = dict:ttl(ckey)
        if ttl and ttl < CONF_TTL - CONF_REFRESH then
            local json = cjson.encode(settings_of(conf))
            if json ~= cur then
                if not dict:safe_set(ckey, json, CONF_TTL) then
                    dict:safe_set(ckey, cur, CONF_TTL)
                end
            else
                dict:expire(ckey, CONF_TTL)
            end
            dict:expire(bkey .. ":reg", CONF_TTL)
        end
    end
    if dict:get(ckey) == nil then return false end
    register(dict, bkey)
    return true
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

local function too_old(encoded)
    local t = occurred_at(encoded)
    return t ~= nil and t < ngx.now() - MAX_EVENT_AGE_SECONDS
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
-- ones first, then ones that are failing. Never except_bkey's own. Returns
-- how many events went.
local function evict_failing(dict, except_bkey, n)
    local evicted = 0
    for _, marker in ipairs({ ":held", ":failing" }) do
        if evicted >= n then break end
        each_destination(dict, function(bkey)
            if bkey ~= except_bkey and dict:get(bkey .. marker) then
                evicted = evicted + drop(dict, bkey, n - evicted, "head")
            end
            if evicted >= n then return "stop" end
        end)
    end
    if evicted > 0 then
        record_drop("buffer_overflow", evicted)
        log_throttled("warn", "evict_failing", 10, "[aforo-metering] Shared dict '", BUFFER_DICT,
            "' is nearly full: dropped the oldest ", evicted, " event(s) of destinations the ingestor ",
            "is refusing or failing, to keep metering the others. Repeats suppressed for 10s.")
    end
    return evicted
end

-- Put events back at the head of the buffer, oldest first, under the same
-- rules as a push. Returns how many of batch are back in the buffer, and how
-- many events were dropped in all -- of batch, and newer ones that made room
-- -- counted exactly: every event removed is attributed to the batch or to the
-- newer events it was taken from.
--
-- Normally the OLDEST are kept: they are the ones closest to falling outside
-- the ingestor's acceptance window, and recent events are recoverable from
-- upstream logs far more often than old ones. A held destination keeps its
-- NEWEST instead. Out of memory, a buffer that is not held makes room at its
-- own newest end first, then by evicting refused or failing destinations'
-- oldest events; a held one evicts nobody.
local function rebuffer(dict, bkey, batch, held)
    local newer = dict:llen(bkey) or 0        -- events buffered while batch was out
    local kept, dropped = 0, 0
    local first = 1
    if held then
        -- Only as many as fit, and those the newest of the batch.
        local room = math.max(0, HELD_MAX_EVENTS - newer)
        if #batch > room then
            first = #batch - room + 1
            dropped = dropped + first - 1
        end
    end

    -- A drop at the newest end takes a newer event while there are any, and
    -- then the newest of the batch already put back.
    local function drop_newest()
        if drop(dict, bkey, 1, "tail") == 0 then return false end
        dropped = dropped + 1
        if newer > 0 then newer = newer - 1 else kept = kept - 1 end
        return true
    end

    for i = #batch, first, -1 do
        local item = batch[i]
        local ok = dict:lpush(bkey, item)
        if not ok and not held then
            if drop_newest() then ok = dict:lpush(bkey, item) end
            if not ok and evict_failing(dict, bkey, EVICT_BATCH) > 0 then
                ok = dict:lpush(bkey, item)
            end
        end
        if ok then kept = kept + 1 else dropped = dropped + 1 end
    end

    local limit = held and HELD_MAX_EVENTS or MAX_BUFFER_SIZE
    local excess = (dict:llen(bkey) or 0) - limit
    if excess > 0 then
        if held then
            -- The batch is at the head: trimming the oldest takes it first.
            local n = drop(dict, bkey, excess, "head")
            local of_batch = math.min(n, kept)
            kept, newer = kept - of_batch, newer - (n - of_batch)
            dropped = dropped + n
        else
            for _ = 1, excess do
                if not drop_newest() then break end
            end
        end
    end
    return kept, dropped
end

-- The per-event errors of a 2xx answer, or nil. /v1/ingest/batch answers
-- 202 in the platform envelope:
--   {"success": true, "data": {accepted, duplicates, failed,
--                              errors = [{index, message}]}}
-- with no top-level errors (locked by the ingestor's
-- KongBatchResponseShapeTest). Only a top-level errors was read, so no
-- per-event failure was ever seen (2026-10-19): an event refused for a spent
-- quota went unreported, and one the ingestor could not store was never sent
-- again -- lost. The bare {accepted, failed, errors} shape is still read, for
-- anything that answers without the envelope.
local function per_event_errors(resp)
    if type(resp) ~= "table" then return nil end
    if type(resp.data) == "table" and type(resp.data.errors) == "table" then
        return resp.data.errors
    end
    if type(resp.errors) == "table" then return resp.errors end
    return nil
end

-- A 2xx can still carry per-event failures (see per_event_errors); index is
-- the event's position in the batch as sent. Returns the events to send
-- again -- storage trouble, retried event by event, not as the whole batch.
-- Every other per-event error is a judgement on the event (over a HARD_LIMIT
-- quota, an unknown metric): it is dropped and logged with the count and the
-- reasons, since resending the same event gets the same answer.
local function per_event_retries(batch, body)
    local errors = per_event_errors(cjson.decode(body or ""))
    if not errors then return {} end

    local retry, rejected = {}, {}
    for _, e in ipairs(errors) do
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
        record_drop("ingestor_rejected", #rejected)
        local sample = {}
        for i = 1, math.min(3, #rejected) do sample[i] = rejected[i] end
        log_throttled("err", "ingest_event_rejected", 60,
            "[aforo-metering] The ingestor rejected ", #rejected, " of ", #batch,
            " event(s) in a batch; dropped, not retried. First reasons: ",
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
-- on_fail, if given, is called at once after every failed attempt -- the
-- first one included, long before the retries are over -- so the destination
-- is marked failing for as long as it actually is (see mark_failing).
local function send_batch(settings, batch, timeout_ms, attempts, on_fail)
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
        if on_fail then on_fail() end
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
                "KEPT and retried with this key, backing off to every 5 minutes. Response: ",
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
            record_drop("rejected", 1)
            log_throttled("err", "ingest_rejected_event_" .. status, 60,
                "[aforo-metering] The ingestor rejected an event with ", status,
                status == 413 and " (too large for the ingestor or a proxy in front of it)" or "",
                " -- dropping it. Response: ", resp_body, ". Repeats suppressed for 60s.")
            return "rejected"
        end

        -- Any other 4xx except 408 / 429: the ingestor understood the batch and
        -- refused it; retrying sends the same bytes to the same judgement.
        if status and status >= 400 and status < 500 and status ~= 408 and status ~= 429 then
            record_drop("rejected", #batch)
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

local function send(ctx, events)
    return send_batch(ctx.settings, events, ctx.timeout_ms, ctx.attempts, ctx.on_fail)
end

-- Send events, bisecting on 400 / 413. Returns the events to keep.
-- ctx: settings, started, timeout_ms, attempts, no_split, on_fail; set here:
-- stop, held, failed, got_2xx. A known (outcome, retry, status) for these
-- events may be passed in.
local deliver
deliver = function(ctx, events, depth, outcome, retry, status)
    if ctx.stop then return events end
    if not outcome then
        if over_budget(ctx) then return events end
        outcome, retry, status = send(ctx, events)
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
        -- are bisected down to single events.
        if over_budget(ctx) then return events end
        local lo, lr, ls = send(ctx, left)
        if lo == "split" and ls == 400 then
            if over_budget(ctx) then return events end
            local ro, rr, rs = send(ctx, right)
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

-- When the next timed flush of this buffer should run: flush_interval_ms,
-- or for a refused destination flush_interval_ms x 2^n (n refused flushes
-- in a row), at most HELD_MAX_BACKOFF.
local function next_delay(dict, bkey, settings)
    local interval = interval_seconds(settings)
    local n = dict:get(bkey .. ":held") and tonumber(dict:get(bkey .. ":held_n")) or 0
    if n <= 0 then return interval end
    return math.min(interval * 2 ^ n, math.max(interval, HELD_MAX_BACKOFF))
end

-- A timed flush is always pending while this buffer holds events: one per
-- buffer across all workers, claimed with safe_add(). The marker lasts as
-- long as the wait, so the re-arm timer cannot cut a back-off short; it is a
-- safety net for a timer lost with its worker.
local function ensure_pending(dict, bkey, settings)
    local delay = next_delay(dict, bkey, settings)
    if dict:safe_add(bkey .. ":pending", true, delay + 10) then
        local ok, err = ngx.timer.at(delay, flush_timer, bkey, false)
        if not ok then
            dict:delete(bkey .. ":pending")
            kong.log.warn("[aforo-metering] Failed to schedule timed flush: ", err)
        end
    end
end

-- Marked at the first failed attempt (before its retries are over), kept
-- until a 2xx; see FAILING_TTL.
local function mark_failing(dict, bkey)
    dict:safe_set(bkey .. ":failing", true, FAILING_TTL)
end

-- Events the ingestor would refuse as too old: dropped here, and said so.
local function drop_expired(dict, settings, batch)
    local fresh, expired = {}, 0
    for _, e in ipairs(batch) do
        if too_old(e) then expired = expired + 1 else fresh[#fresh + 1] = e end
    end
    if expired > 0 then
        record_drop("expired", expired)
        kong.log.err("[aforo-metering] Dropped ", expired, " event(s) for ", settings.aforo_endpoint,
            " older than ", MAX_EVENT_AGE_SECONDS / 3600, " hours: the ingestor no longer accepts them.")
    end
    return fresh
end

local function drain(dict, bkey, settings)
    local ctx = { settings = settings, started = ngx.now(),
                  timeout_ms = SEND_TIMEOUT_MS, attempts = SEND_ATTEMPTS,
                  on_fail = function() mark_failing(dict, bkey) end }
    for _ = 1, math.ceil(MAX_BUFFER_SIZE / MAX_BATCH_SIZE) do
        local popped = pop_batch(dict, bkey, MAX_BATCH_SIZE)
        if #popped == 0 then break end
        local batch = drop_expired(dict, settings, popped)

        local keep = (#batch > 0) and deliver(ctx, batch, 0) or {}

        -- Any 2xx means the destination works: refused and failing are over.
        if ctx.held then
            dict:safe_set(bkey .. ":held", true, HELD_TTL)
            dict:safe_set(bkey .. ":held_n", (tonumber(dict:get(bkey .. ":held_n")) or 0) + 1, HELD_TTL)
        elseif ctx.got_2xx then
            dict:delete(bkey .. ":held")
            dict:delete(bkey .. ":held_n")
            if not ctx.failed then dict:delete(bkey .. ":failing") end
        end

        if #keep > 0 then
            -- Re-buffer what was not delivered (2026-09-01 fix). The events were
            -- taken off the buffer before the first attempt, so an ingestor
            -- outage outlasting the retries used to destroy the only copy of
            -- them: unbilled usage, no dead-letter, nothing to reconstruct from.
            local kept, dropped = rebuffer(dict, bkey, keep, ctx.held)
            local what = ctx.held and "refused" or "failed"
            if dropped > 0 then
                record_drop("buffer_overflow", dropped)
                -- Never throttled: these events are gone.
                kong.log.err("[aforo-metering] Delivery to ", settings.aforo_endpoint, " ", what,
                    ": ", kept, " of ", #keep, " event(s) put back for retry; ", dropped,
                    " event(s) dropped (", ctx.held and ("a refused destination keeps its newest "
                        .. HELD_MAX_EVENTS) or "the buffer or the shared dict is full", ").")
            elseif ctx.held or ctx.failed then
                -- Once a minute per destination: a refused or failing
                -- destination is retried again and again, and one line per
                -- retry buried everything else in the log.
                log_throttled("err", what .. "_" .. bkey, 60, "[aforo-metering] Delivery to ",
                    settings.aforo_endpoint, " ", what, ": ", kept, " event(s) kept for retry",
                    ctx.held and (", next attempt in " .. next_delay(dict, bkey, settings) .. "s") or "",
                    ". Repeats suppressed for 60s.")
            end
        end

        if ctx.stop then
            if ctx.held or ctx.failed then
                -- No immediate flush before the next timed one. Without it,
                -- every request past flush_count started another flush
                -- against an ingestor that was already failing.
                dict:safe_set(bkey .. ":backoff", true, next_delay(dict, bkey, settings))
            end
            return
        end
        if #popped < MAX_BATCH_SIZE then return end
    end
end

-- Worker exiting (kong reload, or a graceful stop): timers run once more with
-- premature = true. One quick best-effort send, no retries, no bisection;
-- what does not go out is put back (the dict survives a reload). The
-- :pending / :kick markers go too: they stood for timers that die with this
-- worker, and left in place they kept the new workers from re-arming.
local function shutdown_send(dict, bkey, settings)
    local batch = drop_expired(dict, settings, pop_batch(dict, bkey, MAX_BATCH_SIZE))
    if #batch == 0 then return end
    local ctx = { settings = settings, started = ngx.now(), no_split = true,
                  timeout_ms = SHUTDOWN_SEND_TIMEOUT_MS, attempts = 1 }
    local keep = deliver(ctx, batch, 0)
    if #keep > 0 then
        local kept, dropped = rebuffer(dict, bkey, keep, ctx.held or dict:get(bkey .. ":held"))
        if dropped > 0 then
            kong.log.err("[aforo-metering] Shutdown flush to ", settings.aforo_endpoint, ": ",
                kept, " event(s) put back, ", dropped, " dropped.")
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
        -- Cannot happen while CONF_TTL outlives MAX_EVENT_AGE_SECONDS (see
        -- rearm); never silent if it does.
        local n = dict:llen(bkey) or 0
        if n > 0 then
            log_throttled("err", "no_settings_" .. bkey, 60, "[aforo-metering] ", n, " buffered ",
                "event(s) have no delivery settings and cannot be sent. Repeats suppressed for 60s.")
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
        record_drop("too_large", 1)
        log_throttled("err", "event_too_large", 60, "[aforo-metering] Not buffering an event of ",
            #encoded, " bytes (the limit is ", MAX_EVENT_BYTES, "). Repeats suppressed for 60s.")
        return false
    end

    local bkey = M.key(conf)
    local settings = settings_of(conf)

    local held = dict:get(bkey .. ":held")
    local count = dict:llen(bkey) or 0
    if held then
        -- Refused: keep the newest -- a new event pushes out the oldest.
        if count >= HELD_MAX_EVENTS then
            record_drop("buffer_overflow", drop(dict, bkey, count - HELD_MAX_EVENTS + 1, "head"))
            log_throttled("warn", "buffer_full_held_" .. bkey, 60, "[aforo-metering] ",
                settings.aforo_endpoint, " is refusing this key's events (401/403/404, or 400 for ",
                "every request), and it keeps only its newest ", HELD_MAX_EVENTS, ": dropping the ",
                "oldest. Fix api_key / aforo_endpoint; see the flush errors. Repeats suppressed for 60s.")
        end
    elseif count >= MAX_BUFFER_SIZE then
        record_drop("buffer_overflow", 1)
        save_settings(dict, bkey, conf)
        log_throttled("warn", "buffer_full", 10, "[aforo-metering] Buffer full for ",
            settings.aforo_endpoint, " (", count, " events) -- dropping the newest event. The ",
            "ingestor is failing or unreachable; see the flush errors. Repeats suppressed for 10s.")
        -- Keep a flush coming: a full buffer must still drain once the
        -- ingestor recovers.
        schedule(dict, bkey, settings, count)
        return false
    end

    -- A refused or failing destination must never cost a healthy one its
    -- events: when the dict runs low, a healthy push evicts their oldest
    -- events -- as many as it takes, while there are any. A refused or
    -- failing destination evicts nobody.
    --
    -- Room first, then this buffer's settings: a buffer never takes an event
    -- it has no settings to deliver with. (The settings used to be written
    -- first; on a full dict that write failed, the eviction then made room,
    -- and the event went into a buffer no flush could ever send.)
    local healthy = not held and not dict:get(bkey .. ":failing")
    if healthy and dict:free_space() < reserve(dict) then
        evict_failing(dict, bkey, EVICT_BATCH)
    end
    local has_settings = save_settings(dict, bkey, conf)
    while not has_settings and healthy do
        if evict_failing(dict, bkey, EVICT_BATCH) == 0 then break end
        has_settings = save_settings(dict, bkey, conf)
    end
    if not has_settings then
        record_drop("buffer_overflow", 1)
        log_throttled("err", "dict_full", 10, "[aforo-metering] Could not buffer an event: ",
            "shared dict '", BUFFER_DICT, "' is full (no room for this destination's settings). The ",
            "ingestor is failing or unreachable -- see the flush errors -- or the dict is small for ",
            "this traffic: raise lua_shared_dict ", BUFFER_DICT, ". Event not metered. Repeats ",
            "suppressed for 10s.")
        return false
    end
    local n, push_err = dict:rpush(bkey, encoded)
    while not n and healthy do
        if evict_failing(dict, bkey, EVICT_BATCH) == 0 then break end
        n, push_err = dict:rpush(bkey, encoded)
    end
    if not n then
        record_drop("buffer_overflow", 1)
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

-- Worker 0, every REARM_INTERVAL: re-arm a flush for every buffer that holds
-- events (after a kong reload, or a worker that crashed, buffered events used
-- to wait for new traffic -- possibly forever), and prune the registry of
-- buffers that are empty and whose settings have expired.
local function rearm(premature)
    if premature then return end
    local dict = ngx.shared[BUFFER_DICT]
    if not dict then return end
    local seen = {}
    each_destination(dict, function(bkey)
        if seen[bkey] then return false end            -- a duplicate entry
        seen[bkey] = true
        local n = dict:llen(bkey) or 0
        local settings = load_settings(dict, bkey)
        if n > 0 then
            if settings then
                ensure_pending(dict, bkey, settings)
            else
                -- push() never buffers without settings, and they outlive every
                -- event (CONF_TTL > MAX_EVENT_AGE_SECONDS, refreshed by pushes);
                -- say so loudly rather than strand events quietly.
                log_throttled("err", "no_settings_" .. bkey, 60, "[aforo-metering] ", n, " buffered ",
                    "event(s) have no delivery settings and cannot be sent. Repeats suppressed for 60s.")
            end
            return true
        end
        if not settings then return false end         -- empty, settings expired: prune
        return true
    end)
end

function M.init_worker()
    if ngx.worker.id() ~= 0 then return end
    local ok, err = ngx.timer.every(REARM_INTERVAL, rearm)
    if not ok then
        kong.log.err("[aforo-metering] Could not start the flush re-arm timer: ", err)
    end
end

-- For tests and handler.lua's export: flush the buffer of this conf's
-- destination now, with conf as its settings.
function M.flush(premature, conf, immediate)
    local dict = ngx.shared[BUFFER_DICT]
    local bkey = M.key(conf)
    if dict then save_settings(dict, bkey, conf) end
    return flush_timer(premature, bkey, immediate)
end

M.MAX_BUFFER_SIZE = MAX_BUFFER_SIZE
M.HELD_MAX_EVENTS = HELD_MAX_EVENTS
M.MAX_EVENT_BYTES = MAX_EVENT_BYTES
M.CONF_TTL = CONF_TTL
M.MAX_EVENT_AGE_SECONDS = MAX_EVENT_AGE_SECONDS
M._rearm = rearm

return M
