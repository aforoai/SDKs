'use strict';
/**
 * Collects Pub/Sub messages from a pull subscription into batches and hands
 * them to a Forwarder. It depends only on the subscription's event-emitter
 * surface (on('message'), on('error'), close()) and each message's data /
 * id / ack() / nack(), so tests drive it with a fake and server.js passes a
 * real @google-cloud/pubsub Subscription.
 *
 * Rules (aforo-metering-sdks/contract/TRANSPORT-SPEC.md, applied to Pub/Sub):
 *   - one flusher: at most one forward() runs at a time
 *   - a flush starts when maxBatchMessages messages are waiting, or
 *     maxWaitMs after the first one arrived
 *   - a message is acked only after every event in it was accepted or
 *     permanently rejected (or the message can never be delivered: not JSON,
 *     no events). Acking is what removes it from the subscription.
 *   - on an outage the batch is nacked, so Pub/Sub redelivers it after the
 *     subscription's retry delay, with the same idempotency keys; the
 *     breaker then pauses flushing for max(250 ms, random(0, ceiling)),
 *     ceiling 5 s * 2^n capped at 5 min, reset by the next successful flush.
 *     Messages that arrive meanwhile wait (their leases are extended by the
 *     client library) and go out when the breaker closes.
 *   - stop(): no new flushes after the deadline; whatever is still waiting
 *     is nacked, never acked, so it is redelivered to the next instance.
 *
 * The subscription's flow control (maxMessages) bounds how many messages are
 * held in memory; set it at or above maxBatchMessages.
 */

const { OutageError } = require('./forwarder');

const BREAKER_BASE_MS = 5000;
const BREAKER_MAX_MS = 5 * 60 * 1000;
const BREAKER_MIN_MS = 250;

class BatchingSubscriber {
    constructor(subscription, forwarder, opts, deps) {
        const o = opts || {};
        const d = deps || {};
        this.subscription = subscription;
        this.forwarder = forwarder;
        this.maxBatchMessages = o.maxBatchMessages || 500;
        this.maxWaitMs = o.maxWaitMs === undefined ? 1000 : o.maxWaitMs;
        this.now = d.now || Date.now;
        this.random = d.random || Math.random;
        this.setTimer = d.setTimeout || setTimeout;
        this.clearTimer = d.clearTimeout || clearTimeout;
        this.log = d.log || { info: function () {}, warn: console.warn, error: console.error };
        this.pending = [];
        this.timer = null;
        this.flushing = null;
        this.breakerOpenings = 0;
        this.breakerUntil = 0;
        this.stopped = false;
        this.stats = { acked: 0, nacked: 0, flushes: 0, outages: 0 };
        this.onMessage = this.add.bind(this);
        this.onError = function (err) {
            this.log.error('aforo-forwarder: subscription error: ' + (err && err.message ? err.message : String(err)));
        }.bind(this);
    }

    start() {
        this.subscription.on('message', this.onMessage);
        this.subscription.on('error', this.onError);
        return this;
    }

    add(message) {
        if (this.stopped) { this.settle([message], false); return; }
        this.pending.push(message);
        this.schedule();
    }

    /** Arms the next flush: now if a batch is full, else after maxWaitMs, never before the breaker closes. */
    schedule() {
        if (this.flushing || this.stopped || this.pending.length === 0) return;
        const full = this.pending.length >= this.maxBatchMessages;
        const wait = Math.max(full ? 0 : this.maxWaitMs, this.breakerUntil - this.now());
        if (this.timer) {
            if (!full || wait > 0) return;
            this.clearTimer(this.timer);
            this.timer = null;
        }
        if (wait <= 0) { this.flush(); return; }
        this.timer = this.setTimer(function () { this.timer = null; this.flush(); }.bind(this), wait);
    }

    /** Sends one batch. Resolves when it is acked or nacked; never rejects. */
    flush() {
        if (this.flushing) return this.flushing;
        if (this.pending.length === 0) return Promise.resolve();
        const batch = this.pending.splice(0, this.maxBatchMessages);
        this.stats.flushes++;
        const self = this;
        this.flushing = this.forwarder.forward(batch.map(function (m) { return m.data; }))
            .then(function (stats) {
                self.breakerOpenings = 0;
                self.breakerUntil = 0;
                self.settle(batch, true);
                self.log.info('aforo-forwarder: messages=' + batch.length + ' accepted=' + stats.accepted
                    + ' rejected=' + stats.rejected + ' invalid=' + stats.invalid + ' duplicates=' + stats.duplicates);
            }, function (err) {
                self.settle(batch, false);
                if (err instanceof OutageError) {
                    self.stats.outages++;
                    self.openBreaker();
                    self.log.error('aforo-forwarder: ' + err.message + '; ' + batch.length
                        + ' message(s) nacked for redelivery');
                } else {
                    // A bug, not an ingest answer: never ack what was not delivered.
                    self.log.error('aforo-forwarder: unexpected error, ' + batch.length + ' message(s) nacked: '
                        + (err && err.stack ? err.stack : String(err)));
                    self.openBreaker();
                }
            })
            .then(function () {
                self.flushing = null;
                self.schedule();
            });
        return this.flushing;
    }

    openBreaker() {
        const ceiling = Math.min(BREAKER_MAX_MS, BREAKER_BASE_MS * Math.pow(2, this.breakerOpenings));
        this.breakerOpenings++;
        this.breakerUntil = this.now() + Math.max(BREAKER_MIN_MS, Math.floor(this.random() * ceiling));
    }

    settle(messages, ok) {
        messages.forEach(function (m) {
            try {
                if (ok) m.ack(); else m.nack();
            } catch (err) {
                this.log.error('aforo-forwarder: could not ' + (ok ? 'ack' : 'nack') + ' message ' + m.id + ': ' + err.message);
            }
        }, this);
        if (ok) this.stats.acked += messages.length; else this.stats.nacked += messages.length;
    }

    /**
     * Stops reading, flushes what is waiting until the deadline, nacks the
     * rest and closes the subscription. Resolves with the stats.
     */
    async stop(deadlineMs) {
        if (this.stopping) return this.stopping;
        const self = this;
        this.stopping = (async function () {
            const deadline = self.now() + (deadlineMs === undefined ? 8000 : deadlineMs);
            self.subscription.removeListener('message', self.onMessage);
            if (self.timer) { self.clearTimer(self.timer); self.timer = null; }
            while (self.now() < deadline && (self.flushing || self.pending.length > 0)) {
                if (!self.flushing && self.breakerUntil > self.now()) break;
                await Promise.race([
                    self.flushing || self.flush(),
                    new Promise(function (r) { self.setTimer(r, Math.max(0, deadline - self.now())); }),
                ]);
            }
            self.stopped = true;
            if (self.timer) { self.clearTimer(self.timer); self.timer = null; }
            if (self.pending.length) {
                self.log.warn('aforo-forwarder: shutting down, ' + self.pending.length + ' message(s) nacked for redelivery');
                self.settle(self.pending.splice(0), false);
            }
            try { await self.subscription.close(); } catch (err) { self.log.error('aforo-forwarder: close failed: ' + err.message); }
            return self.stats;
        })();
        return this.stopping;
    }
}

module.exports = { BatchingSubscriber, BREAKER_BASE_MS, BREAKER_MAX_MS, BREAKER_MIN_MS };
