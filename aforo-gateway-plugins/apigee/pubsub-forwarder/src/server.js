'use strict';
// Cloud Run entry point. Starts one pull subscriber and a tiny HTTP server on
// $PORT (Cloud Run needs a listening port; /healthz answers 200 while the
// subscriber runs). Deploy with --no-cpu-throttling and --min-instances 1:
// a pull subscriber does its work between HTTP requests.
//
// SIGTERM (Cloud Run gives 10 s): stop reading, flush for up to
// AFORO_SHUTDOWN_MS (default 8000), nack what is left, exit.
const http = require('http');
const { Forwarder, configFromEnv } = require('./forwarder');
const { BatchingSubscriber } = require('./subscriber');

function positive(raw, fallback) {
    if (raw === undefined || String(raw).trim() === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new Error('expected a positive integer, got ' + JSON.stringify(raw));
    return n;
}

function main() {
    const subscriptionName = process.env.AFORO_PUBSUB_SUBSCRIPTION;
    if (!/^projects\/[^/]+\/subscriptions\/[^/]+$/.test(subscriptionName || '')) {
        throw new Error('AFORO_PUBSUB_SUBSCRIPTION must be projects/{project}/subscriptions/{subscription}');
    }
    const batch = Math.min(positive(process.env.AFORO_BATCH_MAX_MESSAGES, 500), 1000);
    const log = { info: console.log, warn: console.warn, error: console.error };
    const forwarder = new Forwarder(configFromEnv(process.env), { log: log });

    const { PubSub } = require('@google-cloud/pubsub');
    const subscription = new PubSub().subscription(subscriptionName, {
        flowControl: { maxMessages: Math.max(batch * 2, 1000), allowExcessMessages: false },
    });
    const subscriber = new BatchingSubscriber(subscription, forwarder, {
        maxBatchMessages: batch,
        maxWaitMs: positive(process.env.AFORO_BATCH_MAX_WAIT_MS, 1000),
    }, { log: log }).start();

    const server = http.createServer(function (req, res) {
        const ok = req.url === '/healthz' && !subscriber.stopped;
        res.writeHead(ok ? 200 : 503, { 'Content-Type': 'text/plain' });
        res.end(ok ? 'ok' : 'stopping');
    });
    server.listen(positive(process.env.PORT, 8080));

    process.on('SIGTERM', function () {
        subscriber.stop(positive(process.env.AFORO_SHUTDOWN_MS, 8000)).then(function (stats) {
            log.info('aforo-forwarder: stopped acked=' + stats.acked + ' nacked=' + stats.nacked);
            server.close(function () { process.exit(0); });
        });
    });
    log.info('aforo-forwarder: reading ' + subscriptionName + ', batches of up to ' + batch + ' messages');
}

main();
