package ingest

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Event is one queued usage event.
type Event struct {
	Key  string          // idempotency key, kept on every resend
	Body json.RawMessage // the event as a JSON object
	Ref  any             // the caller's own representation, handed back on drop
}

// FlushResult reports what one Flush did.
type FlushResult struct {
	Sent     int // accepted (or reported duplicate) by the ingestor
	Rejected int // refused by the ingestor and reported through OnDrop
	Pending  int // still queued after the flush
}

// Stats is a point-in-time view of the client.
type Stats struct {
	Queued      int
	Dropped     int64
	BreakerOpen bool
}

type closeRequest struct {
	ctx context.Context
}

// Client is the transport core: bounded queue, single flusher, pooled HTTP
// client, retries with full jitter, requeue-and-breaker on outage and a
// deadline-bounded shutdown.
type Client struct {
	cfg      Config
	url      string
	http     *http.Client
	ownsHTTP bool

	mu     sync.Mutex
	queue  []Event
	closed bool

	wake     chan struct{}
	flushReq chan chan flushReply
	closeReq chan closeRequest
	done     chan struct{}

	runCtx    context.Context
	runCancel context.CancelFunc

	// flusherGID is the id of the sender goroutine. Flush and Close called
	// from a callback running on it must not wait on themselves.
	flusherGID atomic.Uint64
	// closeErr is Close's result, written by the sender before done closes.
	closeErr error

	dropped     atomic.Int64
	throttled   sync.Map // DropReason → *atomic.Int64, for throttled log lines
	breakerOpen atomic.Bool

	// Flusher-only state.
	holdUntil     time.Time
	outages       int
	softRetries   int
	authErrLogged bool
	lastResult    FlushResult
}

type flushReply struct {
	result FlushResult
	err    error
}

// New validates cfg, applies defaults and starts the flusher goroutine.
func New(cfg Config) (*Client, error) {
	if strings.TrimSpace(cfg.APIKey) == "" {
		return nil, fmt.Errorf("aforo: API key is required")
	}
	if err := ValidateBaseURL(cfg.BaseURL, cfg.AllowInsecureHTTP); err != nil {
		return nil, err
	}
	cfg.applyDefaults()
	c := &Client{
		cfg:      cfg,
		url:      strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/") + cfg.Path,
		wake:     make(chan struct{}, 1),
		flushReq: make(chan chan flushReply),
		closeReq: make(chan closeRequest, 1),
		done:     make(chan struct{}),
	}
	if cfg.HTTPClient != nil {
		c.http = withoutRedirects(cfg.HTTPClient)
	} else {
		c.http = newPooledHTTPClient(cfg.Timeout)
		c.ownsHTTP = true
	}
	c.runCtx, c.runCancel = context.WithCancel(context.Background())
	go c.run()
	return c, nil
}

// String never prints the API key.
func (c *Client) String() string {
	return fmt.Sprintf("ingest.Client{url:%q, apiKey:%s}", c.url, RedactKey(c.cfg.APIKey))
}

// Enqueue adds an event. It never blocks on the network and never starts a
// goroutine. After Close it reports the event as DropClosed and returns
// ErrClosed.
func (c *Client) Enqueue(e Event) error {
	var evicted []Event
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		c.Report([]Event{e}, DropClosed)
		return ErrClosed
	}
	c.queue = append(c.queue, e)
	if over := len(c.queue) - c.cfg.MaxQueueSize; over > 0 {
		evicted = c.popFrontLocked(over)
	}
	full := len(c.queue) >= c.cfg.FlushCount
	c.mu.Unlock()
	if len(evicted) > 0 {
		c.Report(evicted, DropOverflow)
	}
	if full {
		select {
		case c.wake <- struct{}{}:
		default: // already awake or about to be
		}
	}
	return nil
}

// Flush asks the flusher to send everything queued and waits for it. It never
// sends concurrently with the flusher. While the breaker is open it still
// makes one attempt (the caller asked); an outage reopens the breaker.
// Called from a callback running on the sender goroutine (OnDrop, OnError,
// OnAccepted) it returns at once: the sender is already sending and carries
// on when the callback returns.
func (c *Client) Flush(ctx context.Context) (FlushResult, error) {
	if c.isClosed() {
		return FlushResult{Pending: c.Len()}, ErrClosed
	}
	if c.onFlusher() {
		return FlushResult{Pending: c.Len()}, nil
	}
	reply := make(chan flushReply, 1)
	select {
	case c.flushReq <- reply:
	case <-ctx.Done():
		return FlushResult{Pending: c.Len()}, ctx.Err()
	case <-c.done:
		return FlushResult{Pending: c.Len()}, ErrClosed
	}
	select {
	case r := <-reply:
		return r.result, r.err
	case <-ctx.Done():
		return FlushResult{Pending: c.Len()}, ctx.Err()
	}
}

// Close stops accepting events, sends what is queued until the shutdown
// deadline — the earlier of ctx's deadline and ShutdownTimeout — and reports
// anything still queued through OnDrop with DropShutdown. It returns nil when
// everything was delivered, an error wrapping ErrShutdownIncomplete otherwise.
// Close is safe to call more than once: a later call waits for the first and
// returns its result; it never runs a second drain.
//
// Called from a callback running on the sender goroutine, Close starts the
// shutdown and returns nil at once; the shutdown runs when the callback
// returns, with the same deadline.
func (c *Client) Close(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	c.mu.Lock()
	already := c.closed
	c.closed = true
	c.mu.Unlock()
	onFlusher := c.onFlusher()
	if already {
		if onFlusher {
			return nil
		}
		<-c.done
		return c.closeErr
	}
	dctx, cancel := context.WithTimeout(ctx, c.cfg.ShutdownTimeout)
	// A request already in flight on the run context is cut off at the
	// deadline too.
	stopCut := context.AfterFunc(dctx, c.runCancel)
	c.closeReq <- closeRequest{ctx: dctx} // buffered; only the first Close sends
	if onFlusher {
		go func() { // release the deadline's resources once the sender is done
			<-c.done
			stopCut()
			cancel()
		}()
		return nil
	}
	<-c.done
	stopCut()
	cancel()
	return c.closeErr
}

// onFlusher reports whether the caller runs on the sender goroutine (that is,
// inside a callback the sender invoked).
func (c *Client) onFlusher() bool {
	id := c.flusherGID.Load()
	return id != 0 && id == goroutineID()
}

// goroutineID reads the current goroutine's id from its stack header
// ("goroutine 42 [running]:"). Used only on Flush/Close, never per event.
func goroutineID() uint64 {
	var buf [64]byte
	b := buf[:runtime.Stack(buf[:], false)]
	b = []byte(strings.TrimPrefix(string(b), "goroutine "))
	if i := strings.IndexByte(string(b), ' '); i > 0 {
		if id, err := strconv.ParseUint(string(b[:i]), 10, 64); err == nil {
			return id
		}
	}
	return 0
}

// Report counts events the SDK gives up on, logs them and calls OnDrop.
// Wrappers use it for events refused before they reach the queue (DropInvalid).
func (c *Client) Report(events []Event, reason DropReason) {
	if len(events) == 0 {
		return
	}
	total := c.dropped.Add(int64(len(events)))
	switch reason {
	case DropOverflow, DropInvalid, DropClosed:
		v, _ := c.throttled.LoadOrStore(reason, new(atomic.Int64))
		n := v.(*atomic.Int64).Add(int64(len(events)))
		if n == int64(len(events)) || n/1000 != (n-int64(len(events)))/1000 {
			c.logf("WARN: dropped %d event(s) — %s (%d %s so far, %d dropped in total).", len(events), reason, n, reason, total)
			if reason == DropClosed {
				c.reportError(KindClosed, 0, events, "event tracked after the client was closed (%d so far)", n)
			}
		}
	default:
		c.logf("WARN: dropped %d event(s) — %s (%d dropped in total).", len(events), reason, total)
	}
	c.callOnDrop(events, reason)
}

// ReportInvalid counts an event refused before it was queued, WARN-logs the
// cause (first, then every 1000th, so a tight loop cannot flood the log) and
// calls OnDrop with DropInvalid.
func (c *Client) ReportInvalid(e Event, cause string) {
	total := c.dropped.Add(1)
	v, _ := c.throttled.LoadOrStore(DropInvalid, new(atomic.Int64))
	if n := v.(*atomic.Int64).Add(1); n == 1 || n%1000 == 0 {
		c.logf("WARN: invalid event dropped, not sent — %s (%d invalid, %d dropped in total).", truncate(cause, 300), n, total)
	}
	c.callOnDrop([]Event{e}, DropInvalid)
}

func (c *Client) callOnDrop(events []Event, reason DropReason) {
	if c.cfg.OnDrop == nil || len(events) == 0 {
		return
	}
	defer func() {
		if r := recover(); r != nil {
			c.logf("WARN: OnDrop hook panicked: %v", r)
		}
	}()
	c.cfg.OnDrop(events, reason)
}

// Len returns the number of queued events.
func (c *Client) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.queue)
}

// QueuedKeys returns the idempotency keys of the queued events, oldest first.
func (c *Client) QueuedKeys() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	keys := make([]string, len(c.queue))
	for i, e := range c.queue {
		keys[i] = e.Key
	}
	return keys
}

// Dropped returns the number of events given up on since creation.
func (c *Client) Dropped() int64 { return c.dropped.Load() }

// Stats returns a snapshot.
func (c *Client) Stats() Stats {
	return Stats{Queued: c.Len(), Dropped: c.Dropped(), BreakerOpen: c.breakerOpen.Load()}
}

// Closed reports whether Close was called.
func (c *Client) Closed() bool { return c.isClosed() }

func (c *Client) isClosed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

func (c *Client) logf(format string, args ...any) {
	c.cfg.Logf(c.cfg.LogPrefix+" "+format, args...)
}

// reportError hands a *TransportError to OnError (panics recovered).
func (c *Client) reportError(kind ErrorKind, status int, events []Event, format string, args ...any) {
	if c.cfg.OnError == nil {
		return
	}
	msg := scrubKey(fmt.Errorf(strings.Trim(c.cfg.LogPrefix, "[]")+": "+format, args...), c.cfg.APIKey).Error()
	te := &TransportError{Kind: kind, Status: status, Message: msg, Events: append([]Event(nil), events...)}
	defer func() {
		if r := recover(); r != nil {
			c.logf("WARN: OnError hook panicked: %v", r)
		}
	}()
	c.cfg.OnError(te)
}

// callOnAccepted hands a 2xx body to OnAccepted (panics recovered).
func (c *Client) callOnAccepted(body json.RawMessage, events []Event) {
	if c.cfg.OnAccepted == nil {
		return
	}
	defer func() {
		if r := recover(); r != nil {
			c.logf("WARN: OnAccepted hook panicked: %v", r)
		}
	}()
	c.cfg.OnAccepted(body, events)
}

// ── queue (callers hold mu) ──

func (c *Client) popFrontLocked(n int) []Event {
	if n > len(c.queue) {
		n = len(c.queue)
	}
	out := make([]Event, n)
	copy(out, c.queue[:n])
	for i := 0; i < n; i++ {
		c.queue[i] = Event{}
	}
	c.queue = c.queue[n:]
	return out
}

// takeBatch removes the next batch: at most FlushCount events and, past the
// first event, at most TargetBodyBytes of JSON body.
func (c *Client) takeBatch() []Event {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.queue) == 0 {
		return nil
	}
	size := len(`{"events":[]}`)
	n := 0
	for n < len(c.queue) && n < c.cfg.FlushCount {
		add := len(c.queue[n].Body) + 1
		if n > 0 && size+add > c.cfg.TargetBodyBytes {
			break
		}
		size += add
		n++
	}
	return c.popFrontLocked(n)
}

// requeueFront puts events back at the front with their keys. If that
// overflows the queue the oldest events are evicted as DropOverflow.
func (c *Client) requeueFront(events []Event) {
	if len(events) == 0 {
		return
	}
	var evicted []Event
	c.mu.Lock()
	q := make([]Event, 0, len(events)+len(c.queue))
	q = append(q, events...)
	q = append(q, c.queue...)
	c.queue = q
	if over := len(c.queue) - c.cfg.MaxQueueSize; over > 0 {
		evicted = c.popFrontLocked(over)
	}
	c.mu.Unlock()
	if len(evicted) > 0 {
		c.Report(evicted, DropOverflow)
	}
}

func (c *Client) drainAll() []Event {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.popFrontLocked(len(c.queue))
}

// ── flusher ──

func (c *Client) run() {
	defer close(c.done)
	c.flusherGID.Store(goroutineID())
	for {
		// Close takes priority over everything else.
		select {
		case req := <-c.closeReq:
			c.shutdown(req.ctx)
			return
		default:
		}

		held := c.holdUntil.After(c.cfg.Hooks.Now())
		wait := c.cfg.FlushInterval
		if held {
			wait = c.holdUntil.Sub(c.cfg.Hooks.Now())
		}
		timer, stop := c.cfg.Hooks.After(wait)
		var reply chan flushReply
		select {
		case req := <-c.closeReq:
			stop()
			c.shutdown(req.ctx)
			return
		case reply = <-c.flushReq:
		case <-c.wake:
			if held {
				stop()
				continue // keep waiting out the cooldown; the queue keeps filling
			}
		case <-timer:
		}
		stop()
		res, err := c.drain(c.runCtx, false)
		if reply != nil {
			reply <- flushReply{result: res, err: err}
		}
	}
}

// drain sends batches until the queue is empty, an outage requeues a batch,
// or ctx ends. In shutdown mode an outage or a per-event retry is retried
// with jittered backoff until ctx's deadline instead of opening the breaker.
func (c *Client) drain(ctx context.Context, shutdown bool) (res FlushResult, err error) {
	defer func() {
		res.Pending = c.Len()
		c.lastResult = res
	}()
	outageAttempt := 0
	for {
		if ctx.Err() != nil {
			return res, ErrIngestUnavailable
		}
		batch := c.takeBatch()
		if len(batch) == 0 {
			return res, nil
		}
		out := c.sendBatch(ctx, batch)
		res.Sent += out.sent
		res.Rejected += out.rejected
		if out.outage {
			c.requeueFront(out.retry)
			if shutdown {
				// Keep trying until the shutdown deadline.
				if c.cfg.Hooks.Sleep(ctx, c.retryDelay(outageAttempt, 0, false)) != nil {
					return res, ErrIngestUnavailable
				}
				outageAttempt++
				continue
			}
			c.openBreaker(out)
			return res, ErrIngestUnavailable
		}
		outageAttempt = 0
		if len(out.retry) == 0 {
			c.softRetries = 0
			c.closeBreaker()
			continue
		}
		// The ingestor asked for these events again (errors[].retryable):
		// resend with the same keys after the normal backoff, at most
		// MaxRetries times, then treat it as an outage.
		c.requeueFront(out.retry)
		c.markReachable()
		c.softRetries++
		if c.softRetries > c.cfg.MaxRetries && !shutdown {
			c.softRetries = 0
			c.openBreaker(sendOutcome{retry: out.retry, status: out.status,
				cause: fmt.Sprintf("the ingestor asked for %d event(s) again more than %d time(s)", len(out.retry), c.cfg.MaxRetries)})
			return res, ErrIngestUnavailable
		}
		delay := c.retryDelay(c.softRetries-1, 0, false)
		if shutdown {
			if c.cfg.Hooks.Sleep(ctx, delay) != nil {
				return res, ErrIngestUnavailable
			}
			continue
		}
		c.holdUntil = c.cfg.Hooks.Now().Add(delay)
		return res, nil
	}
}

func (c *Client) openBreaker(out sendOutcome) {
	wasOpen := c.breakerOpen.Load()
	cool := c.breakerCooldown(c.outages)
	c.outages++
	c.holdUntil = c.cfg.Hooks.Now().Add(cool)
	c.breakerOpen.Store(true)
	queued := c.Len()
	kind := KindOutage
	if out.authStatus != 0 {
		kind = KindAuth
	}
	if !wasOpen {
		c.reportError(kind, out.status, out.retry, "ingestor unavailable (%s); %d event(s) kept in the queue and retried", out.cause, queued)
	}
	switch {
	case out.authStatus != 0:
		if !wasOpen || !c.authErrLogged {
			c.logf("ERROR: the ingestor answered HTTP %d: the API key is wrong or revoked. %d event(s) kept in the queue; retrying in %s.", out.authStatus, queued, cool.Round(time.Millisecond))
			c.authErrLogged = true
		}
	case out.redirect != 0:
		if !wasOpen || !c.authErrLogged {
			c.logf("ERROR: the ingestor answered HTTP %d with a redirect to %s. Redirects are never followed (the API key must not reach another host); fix the base URL. %d event(s) kept in the queue; retrying in %s.", out.redirect, out.location, queued, cool.Round(time.Millisecond))
			c.authErrLogged = true
		}
	default:
		if !wasOpen {
			c.logf("WARN: ingestor unavailable (%s); %d event(s) kept in the queue, retrying in %s.", out.cause, queued, cool.Round(time.Millisecond))
		}
	}
}

// closeBreaker runs after a send the ingestor fully took: it resets the
// outage count, so the next cooldown starts from BreakerInitial again.
func (c *Client) closeBreaker() {
	c.markReachable()
	c.outages = 0
	c.authErrLogged = false
	c.holdUntil = time.Time{}
}

// markReachable records that the ingestor answered 2xx. It does not reset
// the outage count: a per-event retry limit reached after this 2xx keeps
// growing the cooldown.
func (c *Client) markReachable() {
	if c.breakerOpen.Swap(false) {
		c.logf("INFO: ingestor reachable again; sending queued events.")
	}
}

// shutdown drains until ctx's deadline and reports the rest as DropShutdown.
func (c *Client) shutdown(ctx context.Context) {
	// The run context is cancelled by Close at the same deadline; use the
	// shutdown context so a breaker hold does not delay the final send.
	c.holdUntil = time.Time{}
	res, _ := c.drain(ctx, true)
	left := c.drainAll()
	if len(left) > 0 {
		c.reportError(KindShutdown, 0, left, "shutdown deadline passed; %d event(s) not sent", len(left))
		c.Report(left, DropShutdown)
	}
	res.Pending = len(left)
	c.lastResult = res
	c.runCancel()
	if c.ownsHTTP {
		c.http.CloseIdleConnections()
	}
	if len(left) > 0 {
		c.closeErr = fmt.Errorf("%w: %d event(s) reported as %q", ErrShutdownIncomplete, len(left), DropShutdown)
	}
}
