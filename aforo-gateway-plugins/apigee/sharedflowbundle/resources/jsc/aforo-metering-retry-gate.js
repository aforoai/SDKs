/**
 * Aforo Metering - retry gate.
 *
 * Runs right after the first send. This shared flow runs before the client
 * gets its response, so a retry is allowed only when it cannot push the
 * added delay past the budget:
 *
 *   - the first attempt failed to connect, or got a 5xx or a 408. Any
 *     other 4xx is the ingestor's answer and is never re-sent. A 429 is
 *     not re-sent either: honouring its Retry-After would mean holding
 *     the API response, and re-sending at once ignores it;
 *   - it failed within RETRY_WINDOW_MS. A connect timeout (1 s) and a quick
 *     5xx qualify. A response that timed out (connected, then no answer for
 *     2 s) does not: the ingestor is hanging, and a second attempt would
 *     hang too;
 *   - KVM max_retries is not 0. Default 1, and 1 is also the maximum.
 *
 * Worst case added to the API call: about 2 s when the ingestor is
 * unreachable (1 s connect timeout, twice), about 3 s when it accepts the
 * connection and never answers (no retry), about 4 s at the limit.
 *
 * The retry re-sends the 'aforo.eventPayload' variable unchanged: same
 * idempotencyKey, so the ingestor dedups (Rule #21).
 *
 * Rhino-safe (ES5). Never throws on malformed config.
 */

var RETRY_WINDOW_MS = 1200;
var DEFAULT_MAX_RETRIES = 1;
var MAX_RETRIES_CAP = 1;

// KVM max_retries: a whole number. Absent, blank or not a number -> the
// default. Below 0 -> 0. Above the cap -> the cap.
function clampMaxRetries(raw) {
    if (raw === null || raw === undefined) return DEFAULT_MAX_RETRIES;
    var text = ('' + raw).replace(/^\s+|\s+$/g, '');
    if (!/^[+-]?\d+$/.test(text)) return DEFAULT_MAX_RETRIES;
    var n = parseInt(text, 10);
    if (n < 0) return 0;
    if (n > MAX_RETRIES_CAP) return MAX_RETRIES_CAP;
    return n;
}

// delivered: 1xx-3xx. rejected: 4xx except 408. failed (transient):
// transport error, 5xx, 408, or no status at all.
function classifyAttempt(failedFlag, statusRaw) {
    var status = parseInt(statusRaw, 10);
    var failed = failedFlag === true || failedFlag === 'true';
    if (isNaN(status)) return 'failed';
    if (status >= 500 || status === 408) return 'failed';
    if (failed) return 'failed';
    if (status >= 400) return 'rejected';
    return 'delivered';
}

var maxRetries = clampMaxRetries(context.getVariable('private.aforo.maxRetries'));
var firstAttempt = classifyAttempt(
    context.getVariable('servicecallout.AforoMeteringSendEvent.failed'),
    context.getVariable('aforo.calloutResponse.status.code'));

var startMs = parseInt(context.getVariable('aforo.meteringSendStartMs'), 10);
var elapsedMs = isNaN(startMs) ? -1 : (new Date().getTime() - startMs);
// No start time means the elapsed time is unknown: do not retry.
var withinWindow = elapsedMs >= 0 && elapsedMs <= RETRY_WINDOW_MS;

var retry = firstAttempt === 'failed' && maxRetries >= 1 && withinWindow;

context.setVariable('aforo.meteringFirstAttempt', firstAttempt);
context.setVariable('aforo.meteringFirstAttemptMs', String(elapsedMs));
context.setVariable('aforo.meteringMaxRetries', String(maxRetries));
context.setVariable('aforo.meteringRetry', retry ? 'true' : 'false');
