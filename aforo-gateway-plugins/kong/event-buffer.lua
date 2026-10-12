-- Aforo event buffer and delivery for Kong Gateway.
--
-- handler.lua's log phase hands each JSON-encoded event to M.push(conf, json).
-- Timers drain the buffer to the ingestor's batch endpoint (aforo_endpoint).
-- Nothing here runs on the request path except the push and the scheduling
-- checks next to it.
--
-- Shared memory: the aforo_buffer dict (lua_shared_dict aforo_buffer 10m).
-- Per destination -- one aforo_endpoint + api_key + tenant_id -- it holds:
--   <key>            the events, a list, one encoded event per element
--   <key>:lock       a flush is running (at most one per buffer, all workers)
--   <key>:pending    a timed flush is scheduled
--   <key>:kick       an immediate (flush_count) flush is scheduled
--   <key>:backoff    the last flush failed; no immediate flush until it expires

local http = require("resty.http")
local cjson = require("cjson.safe")

local M = {}

local BUFFER_DICT = "aforo_buffer"

-- Per buffer, i.e. per destination. Past it the newest events are dropped.
local MAX_BUFFER_SIZE = 10000

-- The ingestor rejects a batch of more than 1000 events with 400, so a
-- backlog (after an outage, say) is drained in slices no larger than this,
-- rather than as one oversized request.
local MAX_BATCH_SIZE = 1000

-- Longest Retry-After (seconds) honoured on a 429 before the next attempt.
-- The flush runs in a timer, so a longer wait would only hold later slices;
-- past this the batch is re-buffered for a later flush instead.
local MAX_RETRY_AFTER_SECONDS = 30

-- One flush stops taking new slices after this long, leaving the rest to the
-- next one. Worst case for a single slice is three 10 s attempts with two
-- 30 s Retry-After waits (~90 s), so the lock outlives budget + one slice.
local FLUSH_BUDGET_SECONDS = 60
local FLUSH_LOCK_TTL = 180

local SEND_TIMEOUT_MS = 10000
local SEND_ATTEMPTS = 3
-- Worker exiting (reload / shutdown): one quick try, no retries.
local SHUTDOWN_SEND_TIMEOUT_MS = 2000

-- The prefix the ingestor puts on a per-event failure that is about storage,
-- not about the event (UsageIngestionServiceImpl.batchErrorMessage: a
-- DataAccessException / TransactionException). Those are worth sending again;
-- every other per-event error is a judgement on the event itself.
local TRANSIENT_EVENT_ERROR = "The event could not be stored"

local function log_throttled(level, key, ttl, ...)
    local dict = ngx.shared[BUFFER_DICT]
    if dict and not dict:add("aforo:warn:" .. key, 1, ttl) then return end
    kong.log[level](...)
end

local function interval_seconds(conf)
    return math.max(0.05, (tonumber(conf.flush_interval_ms) or 5000) / 1000)
end

-- One buffer per destination (2026-10-12 fix). The buffer used to be one
-- global key, and a flush sent whatever it held with the conf of the plugin
-- instance whose timer happened to run -- so with two instances (two tenants,
-- or two keys), tenant B's events were posted with tenant A's api_key to
-- tenant A's endpoint and billed to tenant A. Each buffer now holds the
-- events of exactly one aforo_endpoint + api_key + tenant_id, and each flush
-- drains only its own. Hashed so the API key itself is not part of the key.
function M.key(conf)
    local id = (conf.aforo_endpoint or "") .. "\n" .. (conf.api_key or "") .. "\n" .. (conf.tenant_id or "")
    return "aforo:events:" .. ngx.md5(id)
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

-- Put events back at the head of the buffer, oldest first, and trim the tail
-- back to MAX_BUFFER_SIZE. Returns how many events were dropped.
--
-- Ordering: failed events are older than anything buffered during the
-- attempt, so they go in front. On overflow we keep the OLDEST and drop the
-- newest, because the oldest are the ones closest to falling outside the
-- ingestor's 90-day occurredAt acceptance window -- and losing recent events
-- is recoverable from upstream logs far more often than losing old ones.
local function rebuffer(dict, bkey, batch)
    local dropped = 0
    for i = #batch, 1, -1 do
        local len, err = dict:lpush(bkey, batch[i])
        if not len then
            -- Only "no memory" in practice: the dict is full. The events
            -- further down this loop are newer, so this is still "drop newest".
            kong.log.err("[aforo-metering] Could not re-buffer event: ", err)
            dropped = dropped + 1
        end
    end
    local len = dict:llen(bkey) or 0
    while len > MAX_BUFFER_SIZE do
        if not dict:rpop(bkey) then break end
        dropped = dropped + 1
        len = len - 1
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
--   "split"         400 or 413 on a batch of several events: send it in halves
--   "rejected"      permanent refusal (the events are dropped, and logged)
--   "failed"        keep the events and try again later: a transient failure
--                   (5xx, timeout, 408, 429), or 401 / 403 / 404
local function send_batch(conf, batch, timeout_ms, attempts)
    local httpc = http.new()
    httpc:set_timeout(timeout_ms)

    -- Each element is already a JSON-encoded event, so the body is assembled
    -- rather than decoded and re-encoded: cheaper, and the bytes sent are
    -- exactly the bytes buffered.
    local body = '{"events":[' .. table.concat(batch, ",") .. ']}'

    for attempt = 1, attempts do
        local res, err = httpc:request_uri(conf.aforo_endpoint, {
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
                ["X-API-Key"]     = conf.api_key or "",
                ["X-Tenant-Id"]   = conf.tenant_id or "",
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
            kong.log.err("[aforo-metering] TLS verification failed for ", conf.aforo_endpoint, ". ",
                "This is usually lua_ssl_verify_depth, which Kong defaults to 1 -- too shallow for a ",
                "leaf/intermediate/root chain. Set lua_ssl_verify_depth = 3 in kong.conf (or ",
                "KONG_LUA_SSL_VERIFY_DEPTH=3). Adding CA certificates will not help: Kong already ",
                "trusts the system bundle via lua_ssl_trusted_certificate.")
        end

        -- 401 / 403 / 404: a rotated or revoked key, a key without
        -- usage-events:ingest, or a wrong aforo_endpoint. Not the events'
        -- fault, and nothing a retry in the next second fixes -- but the
        -- operator can fix it, and the events must still be here when they
        -- do. These used to be dropped as permanent rejections. Kept now, up
        -- to MAX_BUFFER_SIZE, and the log says so loudly.
        if status == 401 or status == 403 or status == 404 then
            log_throttled("err", "ingest_auth_" .. status, 60,
                "[aforo-metering] The ingestor answered ", status, " for ", conf.aforo_endpoint,
                " -- check api_key, its usage-events:ingest permission, tenant_id and ",
                "aforo_endpoint. Events are KEPT and retried every flush_interval_ms (up to ",
                MAX_BUFFER_SIZE, " buffered; newer ones are dropped past that). Response: ",
                resp_body, ". Repeats suppressed for 60s.")
            return "failed"
        end

        -- 400: the ingestor could not read the batch at all (one malformed
        -- event fails the whole request -- non-UTF-8 bytes are the classic).
        -- 413: too big. Either way, halves may well pass: bisect, so one bad
        -- event costs only itself, not everyone it was batched with. A single
        -- event that still gets 400 is dropped, with the reason.
        if status == 400 or status == 413 then
            if #batch > 1 then return "split" end
            log_throttled("err", "ingest_rejected_event", 60,
                "[aforo-metering] The ingestor rejected an event with ", status,
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

-- Send events, bisecting on 400 / 413. Returns the events to keep. Once a
-- send fails transiently, ctx.stop is set and whatever is left is kept
-- unsent: the next part would only fail the same way, slowly.
local function deliver(conf, events, ctx, timeout_ms, attempts)
    if ctx.stop then return events end
    local outcome, retry = send_batch(conf, events, timeout_ms, attempts)
    if outcome == "sent" then
        if #retry > 0 then ctx.stop = true end
        return retry
    elseif outcome == "split" then
        local mid = math.floor(#events / 2)
        local keep = deliver(conf, slice(events, 1, mid), ctx, timeout_ms, attempts)
        for _, e in ipairs(deliver(conf, slice(events, mid + 1, #events), ctx, timeout_ms, attempts)) do
            keep[#keep + 1] = e
        end
        return keep
    elseif outcome == "rejected" then
        return {}
    end
    ctx.stop = true
    return events
end

local flush_timer

-- A timed flush is always pending while this buffer holds events: one per
-- buffer across all workers, claimed with add(). The TTL is a safety net for
-- a timer lost with its worker; it lets the next push schedule a new one.
local function ensure_pending(conf, dict, bkey)
    local interval = interval_seconds(conf)
    if dict:add(bkey .. ":pending", true, interval + 10) then
        local ok, err = ngx.timer.at(interval, flush_timer, conf, false)
        if not ok then
            dict:delete(bkey .. ":pending")
            kong.log.warn("[aforo-metering] Failed to schedule timed flush: ", err)
        end
    end
end

local function drain(conf, dict, bkey)
    local started = ngx.now()
    local ctx = { stop = false }
    for _ = 1, math.ceil(MAX_BUFFER_SIZE / MAX_BATCH_SIZE) do
        if ngx.now() - started > FLUSH_BUDGET_SECONDS then return end

        local batch = pop_batch(dict, bkey, MAX_BATCH_SIZE)
        if #batch == 0 then return end

        local keep = deliver(conf, batch, ctx, SEND_TIMEOUT_MS, SEND_ATTEMPTS)
        if #keep > 0 then
            -- Re-buffer what was not delivered (2026-09-01 fix). The events were
            -- taken off the buffer before the first attempt, so an ingestor
            -- outage outlasting the retries used to destroy the only copy of
            -- them: unbilled usage, no dead-letter, nothing to reconstruct from.
            local dropped = rebuffer(dict, bkey, keep)
            if dropped > 0 then
                kong.log.err("[aforo-metering] Delivery failed. ", #keep, " event(s) re-buffered for ",
                    "retry; ", dropped, " dropped (buffer at MAX_BUFFER_SIZE=", MAX_BUFFER_SIZE,
                    "). Raise lua_shared_dict aforo_buffer if this recurs.")
            else
                kong.log.err("[aforo-metering] Delivery failed. ", #keep,
                    " event(s) re-buffered for retry on the next flush.")
            end
        end

        if ctx.stop then
            -- Back off: no immediate flush until flush_interval_ms has passed.
            -- Without it, every request past flush_count started another
            -- flush against an ingestor that was already failing -- one POST
            -- per request, and the timers starved everything else in Kong.
            dict:set(bkey .. ":backoff", true, interval_seconds(conf))
            return
        end
        if #batch < MAX_BATCH_SIZE then return end
    end
end

-- Worker exiting (kong reload, or a graceful stop): timers run once more with
-- premature = true. This used to return straight away, leaving whatever was
-- buffered to a worker that may never come. One quick best-effort send now;
-- what does not go out is put back (the dict survives a reload).
local function shutdown_send(conf, dict, bkey)
    local batch = pop_batch(dict, bkey, MAX_BATCH_SIZE)
    if #batch == 0 then return end
    local keep = deliver(conf, batch, { stop = false }, SHUTDOWN_SEND_TIMEOUT_MS, 1)
    if #keep > 0 then rebuffer(dict, bkey, keep) end
end

flush_timer = function(premature, conf, immediate)
    local dict = ngx.shared[BUFFER_DICT]
    if not dict then
        kong.log.err("[aforo-metering] Shared dict '", BUFFER_DICT, "' not found")
        return
    end
    local bkey = M.key(conf)

    if premature then
        local ok, err = pcall(shutdown_send, conf, dict, bkey)
        if not ok then kong.log.err("[aforo-metering] Shutdown flush failed: ", tostring(err)) end
        return
    end

    if not immediate then dict:delete(bkey .. ":pending") end

    -- At most one flush per buffer at a time, across workers.
    if dict:add(bkey .. ":lock", true, FLUSH_LOCK_TTL) then
        local ok, err = pcall(drain, conf, dict, bkey)
        dict:delete(bkey .. ":lock")
        if not ok then kong.log.err("[aforo-metering] Flush failed: ", tostring(err)) end
    end
    if immediate then dict:delete(bkey .. ":kick") end

    if (dict:llen(bkey) or 0) > 0 then
        ensure_pending(conf, dict, bkey)
    end
end

-- Make sure a flush is coming, without piling up timers: the timed one (see
-- ensure_pending), plus one immediate flush once flush_count events wait --
-- unless a flush is already running or the last one failed recently. Before
-- 2026-10-12 every push past flush_count scheduled a timer of its own, and
-- the timed flush was only ever scheduled for the first event of an empty
-- buffer, so after one failed flush (or a reload) events could sit unsent
-- until flush_count more arrived.
local function schedule(conf, dict, bkey, count)
    ensure_pending(conf, dict, bkey)
    if count >= (conf.flush_count or 50)
        and not dict:get(bkey .. ":lock")
        and not dict:get(bkey .. ":backoff")
        and dict:add(bkey .. ":kick", true, FLUSH_LOCK_TTL) then
        local ok, err = ngx.timer.at(0, flush_timer, conf, true)
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
    local bkey = M.key(conf)

    -- One atomic append; the returned length is this event's position, so it
    -- doubles as the count that drives flush scheduling without a separate
    -- counter that could drift from the list.
    local count, push_err = dict:rpush(bkey, encoded)
    if not count then
        kong.log.err("[aforo-metering] Could not buffer event (", push_err, "). ",
            "Raise lua_shared_dict aforo_buffer if this recurs. Event not metered.")
        return false
    end

    if count > MAX_BUFFER_SIZE then
        -- Over the cap: take one event back off the tail. That is this event or
        -- one a concurrent worker appended a moment later -- either way the
        -- newest, so the oldest (closest to the ingestor's acceptance window)
        -- are the ones kept, matching the re-buffer rule.
        dict:rpop(bkey)
        log_throttled("warn", "buffer_overflow", 10,
            "[aforo-metering] Buffer full (", MAX_BUFFER_SIZE, " events) -- dropping the ",
            "newest event. The ingestor is failing or unreachable; see the flush errors. ",
            "Repeats suppressed for 10s.")
        -- Keep a flush coming: a full buffer must still drain once the
        -- ingestor recovers.
        schedule(conf, dict, bkey, MAX_BUFFER_SIZE)
        return false
    end

    schedule(conf, dict, bkey, count)
    return true
end

M.flush = flush_timer
M.MAX_BUFFER_SIZE = MAX_BUFFER_SIZE

return M
