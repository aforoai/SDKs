/**
 * aforo-metering, delivery_mode = "sync" only: reads the ingestor's answer.
 * Two policies run this script with a different `phase` property:
 *
 * phase "first" (AforoMeteringCheckDelivery), after AforoMeteringSendEvent:
 *   POST /v1/ingest/batch answers 202
 *     {"success":true,"data":{"accepted":n,"failed":m,"errors":[{index,message}]}}
 *   - an error whose message starts "The event could not be stored" is
 *     transient: that event is re-sent once (AforoMeteringSendEventRetry1,
 *     body aforo.retryPayload). Its idempotencyKey is unchanged, so a copy
 *     that did land is deduplicated, never billed twice.
 *   - any other per-event error is permanent: the event is dropped and logged.
 *   - no answer (connection error, timeout), 5xx or 408: the whole batch is
 *     re-sent once, for the same reason safely.
 *   - 429 is not re-sent at once (it would ignore Retry-After while the
 *     client waits); any other 4xx is the ingestor refusing the request
 *     (api_key, endpoint): dropped and logged.
 *   The retry runs only when the first attempt failed within 1200 ms (this
 *   flow holds the client's response; a hanging ingestor is not waited on
 *   twice) and KVM max_retries is not 0 (default 1, also the maximum).
 *
 * phase "final" (AforoMeteringLogDeliveryFailure), when the first attempt did
 *   not deliver everything: reads the retry's answer the same way and logs
 *   what is lost for good.
 *
 * Variables: aforo.meteringFirstAttempt (delivered | partial | failed |
 * rejected), aforo.meteringRetry, aforo.retryPayload,
 * aforo.meteringDeliveryFailed, aforo.meteringDroppedEvents. print() lines
 * show in a Debug session.
 */

var RETRY_WINDOW_MS = 1200;

function v(name) {
    var x = context.getVariable(name);
    return (x === null || x === undefined) ? '' : ('' + x);
}

function phase() {
    try {
        return (properties && properties.phase) ? '' + properties.phase : 'first';
    } catch (e) {
        return 'first';
    }
}

// The answer to one attempt:
//   { kind: delivered | partial | failed | rejected, transient: [index],
//     permanent: [{index, message}], status }
function classify(responseVar) {
    var status = parseInt(v(responseVar + '.status.code'), 10);
    if (isNaN(status)) return { kind: 'failed', status: 'no-response', transient: null, permanent: [] };
    if (status >= 500 || status === 408) return { kind: 'failed', status: status, transient: null, permanent: [] };
    if (status >= 400) {
        var why = status === 429
            ? 'the ingestor answered 429 (rate limited); not re-sent while the client waits'
            : 'the ingestor refused the request (' + status + '; check api_key and aforo_endpoint): ' +
              v(responseVar + '.content').substring(0, 300);
        return { kind: 'rejected', status: status, transient: [], permanent: [{ index: -1, message: why }] };
    }
    var errors = [];
    try {
        var body = JSON.parse(v(responseVar + '.content') || '{}');
        if (body && body.data && typeof body.data === 'object' && body.data.errors && typeof body.data.errors.length === 'number') {
            errors = body.data.errors;
        } else if (body && body.errors && typeof body.errors.length === 'number') {
            errors = body.errors;
        }
    } catch (e) {
        errors = [];
    }
    var transient = [];
    var permanent = [];
    for (var i = 0; i < errors.length; i++) {
        var err = errors[i] || {};
        var idx = parseInt(err.index, 10);
        var msg = typeof err.message === 'string' ? err.message : '';
        if (isNaN(idx)) continue;
        if (msg.indexOf(AFORO_TRANSIENT_EVENT_ERROR) === 0) transient.push(idx);
        else permanent.push({ index: idx, message: msg });
    }
    var kind = (transient.length === 0 && permanent.length === 0) ? 'delivered' : 'partial';
    return { kind: kind, status: status, transient: transient, permanent: permanent };
}

function events(payloadVar) {
    try {
        var p = JSON.parse(v(payloadVar));
        return (p && p.events && typeof p.events.length === 'number') ? p.events : [];
    } catch (e) {
        return [];
    }
}

function describe(ev) {
    return ev ? (ev.metricName + ' ' + ev.idempotencyKey) : '?';
}

function logPermanent(list, sent, attempt) {
    for (var i = 0; i < list.length; i++) {
        var p = list[i];
        print('[aforo-metering] USAGE EVENT REFUSED (attempt ' + attempt + ', permanent): ' +
            (p.index >= 0 ? describe(sent[p.index]) : 'whole batch') + ' : ' + p.message);
    }
}

function maxRetries() {
    var raw = aforoCfg('maxRetries');
    if (!/^[+-]?\d+$/.test(raw)) return 1;
    var n = parseInt(raw, 10);
    return n <= 0 ? 0 : 1;
}

if (phase() === 'first') {
    var sent = events('aforo.eventPayload');
    var r = classify('aforo.calloutResponse');
    logPermanent(r.permanent, sent, 1);

    var resend = [];
    if (r.kind === 'failed') {
        resend = sent;
    } else if (r.transient) {
        for (var t = 0; t < r.transient.length; t++) {
            if (sent[r.transient[t]]) resend.push(sent[r.transient[t]]);
        }
    }
    var start = parseInt(v('aforo.meteringSendStartMs'), 10);
    var elapsed = isNaN(start) ? -1 : new Date().getTime() - start;
    var inWindow = elapsed >= 0 && elapsed <= RETRY_WINDOW_MS;
    var retry = resend.length > 0 && inWindow && maxRetries() >= 1;

    context.setVariable('aforo.meteringFirstAttempt', r.kind);
    context.setVariable('aforo.meteringFirstAttemptStatus', String(r.status));
    context.setVariable('aforo.meteringFirstAttemptMs', String(elapsed));
    context.setVariable('aforo.meteringRetry', retry ? 'true' : 'false');
    context.setVariable('aforo.meteringPendingCount', String(resend.length));
    if (retry) {
        context.setVariable('aforo.retryPayload', JSON.stringify({ events: resend }));
    } else if (resend.length > 0) {
        context.setVariable('aforo.retryPayload', JSON.stringify({ events: resend }));
        for (var d = 0; d < resend.length; d++) {
            print('[aforo-metering] USAGE EVENT DROPPED (not retried: ' +
                (inWindow ? 'max_retries=0' : 'first attempt took ' + elapsed + ' ms') + ', status ' +
                r.status + '): ' + describe(resend[d]));
        }
    }
    context.setVariable('aforo.meteringDeliveryFailed',
        (r.kind === 'delivered') ? 'false' : 'true');
} else {
    var pending = events('aforo.retryPayload');
    var lost = 0;
    if (v('aforo.meteringRetry') === 'true') {
        var rr = classify('aforo.calloutResponseRetry1');
        logPermanent(rr.permanent, pending, 2);
        if (rr.kind === 'failed') {
            lost = pending.length;
            for (var k = 0; k < pending.length; k++) {
                print('[aforo-metering] USAGE EVENT DROPPED (retry got ' + rr.status + '): ' + describe(pending[k]));
            }
        } else if (rr.transient) {
            lost = rr.transient.length + rr.permanent.length;
            for (var m = 0; m < rr.transient.length; m++) {
                print('[aforo-metering] USAGE EVENT DROPPED (still not stored after the retry): ' +
                    describe(pending[rr.transient[m]]));
            }
        }
        context.setVariable('aforo.meteringRetryAttempt', rr.kind);
    } else {
        lost = pending.length;
    }
    context.setVariable('aforo.meteringDroppedEvents', String(lost));
}
