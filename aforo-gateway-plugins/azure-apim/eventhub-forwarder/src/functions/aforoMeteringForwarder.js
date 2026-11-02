'use strict';
// Azure Functions (Node.js v4 programming model) registration for the
// forwarder. All logic lives in ../forwarder.js, which has no Azure
// dependency and is what the tests exercise.
//
// Event Hubs trigger + retry policy: when the handler throws (an ingest
// outage), the runtime re-runs the SAME batch with exponential back-off and
// does not checkpoint until a run succeeds. maxRetryCount -1 = retry until
// the ingestor is back; the hub's retention (1-7 days) bounds the outage
// that can be absorbed. A successful run checkpoints, so events are only
// "done" once the ingestor accepted (or permanently rejected) them.
const { app } = require('@azure/functions');
const { Forwarder, configFromEnv } = require('../forwarder');

let forwarder = null;
function getForwarder(context) {
    if (!forwarder) {
        forwarder = new Forwarder(configFromEnv(process.env), {
            log: {
                info: function (m) { context.log(m); },
                warn: function (m) { context.warn(m); },
                error: function (m) { context.error(m); },
            },
        });
    }
    return forwarder;
}

app.eventHub('aforoMeteringForwarder', {
    connection: 'AFORO_EVENTHUB_CONNECTION',
    eventHubName: '%AFORO_EVENTHUB_NAME%',
    consumerGroup: '%AFORO_EVENTHUB_CONSUMER_GROUP%',
    cardinality: 'many',
    retry: {
        strategy: 'exponentialBackoff',
        maxRetryCount: -1,
        minimumInterval: { seconds: 5 },
        maximumInterval: { minutes: 5 },
    },
    handler: async function (messages, context) {
        const f = getForwarder(context);
        f.log = {
            info: function (m) { context.log(m); },
            warn: function (m) { context.warn(m); },
            error: function (m) { context.error(m); },
        };
        const stats = await f.forward(messages);
        context.log('aforo-forwarder: accepted=' + stats.accepted + ' rejected=' + stats.rejected
            + ' invalid=' + stats.invalid + ' duplicates=' + stats.duplicates);
    },
});
