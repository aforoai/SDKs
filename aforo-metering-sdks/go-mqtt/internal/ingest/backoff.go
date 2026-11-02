package ingest

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// retryDelay is full jitter: random(0, min(maxDelay, base·2^attempt)). With a
// readable Retry-After the delay is max(retryAfter, jittered), capped at
// MaxRetryAfter.
func (c *Client) retryDelay(attempt int, retryAfter time.Duration, hasRetryAfter bool) time.Duration {
	capd := c.cfg.MaxRetryDelay
	if attempt < 30 {
		if d := c.cfg.RetryBase << uint(attempt); d > 0 && d < capd {
			capd = d
		}
	}
	delay := time.Duration(c.cfg.Hooks.Rand() * float64(capd))
	if hasRetryAfter && retryAfter > delay {
		delay = retryAfter
	}
	if delay > c.cfg.MaxRetryAfter {
		delay = c.cfg.MaxRetryAfter
	}
	if delay < 0 {
		delay = 0
	}
	return delay
}

// breakerCooldown returns the pause after the n-th consecutive outage (n from
// 0): max(250 ms, random(0, ceiling)), ceiling = BreakerInitial·2^n capped at
// BreakerMax (contract/TRANSPORT-SPEC.md, "Breaker cooldown"). Full jitter
// spreads clients that failed together; the floor stops a zero-length pause.
func (c *Client) breakerCooldown(n int) time.Duration {
	ceiling := c.cfg.BreakerMax
	if n < 30 {
		if d := c.cfg.BreakerInitial << uint(n); d > 0 && d < ceiling {
			ceiling = d
		}
	}
	d := time.Duration(c.cfg.Hooks.Rand() * float64(ceiling))
	if d < breakerFloor {
		d = breakerFloor
	}
	return d
}

// breakerFloor is the shortest breaker pause.
const breakerFloor = 250 * time.Millisecond

// ParseRetryAfter reads a Retry-After value in either form (delta-seconds or
// HTTP-date). ok is false for a missing or unreadable value. A date in the
// past gives 0.
func ParseRetryAfter(value string, now time.Time) (time.Duration, bool) {
	v := strings.TrimSpace(value)
	if v == "" {
		return 0, false
	}
	if deltaSeconds.MatchString(v) {
		secs, err := strconv.ParseFloat(v, 64)
		if err != nil {
			return 0, false
		}
		if secs > (24 * time.Hour).Seconds() {
			secs = (24 * time.Hour).Seconds()
		}
		return time.Duration(secs * float64(time.Second)), true
	}
	if t, err := http.ParseTime(v); err == nil {
		d := t.Sub(now)
		if d < 0 {
			d = 0
		}
		return d, true
	}
	return 0, false
}

// deltaSeconds is a non-negative decimal number of seconds ("2", "1.5").
// Signs, exponents, hex and NaN/Inf are not delay values.
var deltaSeconds = regexp.MustCompile(`^[0-9]+(\.[0-9]+)?$`)
