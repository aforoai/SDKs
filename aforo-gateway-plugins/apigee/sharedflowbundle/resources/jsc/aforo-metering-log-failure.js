/**
 * Aforo Metering - delivery failure log.
 *
 * Runs when the first send did not deliver the event (see the Condition in
 * sharedflows/default.xml). If the retry then delivered it, nothing is
 * logged. Otherwise the usage event is dropped at the gateway: this prints
 * its identity to the debug session and sets
 *   aforo.meteringDeliveryFailed     "true"
 *   aforo.meteringDeliveryLastStatus last HTTP status, or "no-response"
 *   aforo.meteringDeliveryAttempts   1 or 2
 *   aforo.meteringDeliveryReason     unreachable / server_error / timeout /
 *                                    rejected
 *   aforo.meteringDeliveryRetryAfter the ingestor's Retry-After on a 429
 * and prints the ingestor's response body (first 500 characters) for a 4xx
 * so a MessageLogging policy or an analytics DataCapture in your own flow
 * can pick them up.
 *
 * The idempotencyKey is request identity, so if the same event reaches the
 * ingestor some other way it dedups.
 */

var msgId = context.getVariable('messageid') || '';
var retried = context.getVariable('aforo.meteringRetry') === 'true';

var failedFlag = context.getVariable(retried
    ? 'servicecallout.AforoMeteringSendEventRetry1.failed'
    : 'servicecallout.AforoMeteringSendEvent.failed');
var statusRaw = context.getVariable(retried
    ? 'aforo.calloutResponseRetry1.status.code'
    : 'aforo.calloutResponse.status.code');
var status = parseInt(statusRaw, 10);
var transportFailed = failedFlag === true || failedFlag === 'true';

var delivered = !isNaN(status) && status < 400 && !transportFailed;

if (delivered) {
    context.setVariable('aforo.meteringDeliveryFailed', 'false');
} else {
    var reason = isNaN(status) ? 'unreachable'
        : status >= 500 ? 'server_error'
        : status === 408 ? 'timeout' : 'rejected';
    var respVar = retried ? 'aforo.calloutResponseRetry1' : 'aforo.calloutResponse';
    var body = '';
    var retryAfter = '';
    if (!isNaN(status) && status >= 400 && status < 500) {
        var rawBody = context.getVariable(respVar + '.content');
        body = (rawBody === null || rawBody === undefined) ? '' : ('' + rawBody).substring(0, 500);
        var rawRetryAfter = context.getVariable(respVar + '.header.Retry-After');
        retryAfter = (rawRetryAfter === null || rawRetryAfter === undefined) ? '' : ('' + rawRetryAfter);
    }
    var lastStatus = isNaN(status) ? 'no-response' : String(status);
    var attempts = retried ? 2 : 1;

    print('[aforo-metering] USAGE EVENT DROPPED: messageid=' + msgId +
        ' reason=' + reason + ' last status=' + lastStatus +
        ' attempts=' + attempts +
        (retryAfter ? ' retry-after=' + retryAfter : '') +
        (body ? ' response=' + body : '') +
        '. The API response is unaffected.');

    context.setVariable('aforo.meteringDeliveryFailed', 'true');
    context.setVariable('aforo.meteringDeliveryLastStatus', lastStatus);
    context.setVariable('aforo.meteringDeliveryAttempts', String(attempts));
    context.setVariable('aforo.meteringDeliveryReason', reason);
    context.setVariable('aforo.meteringDeliveryRetryAfter', retryAfter);
}
