/**
 * Client-side mirror of the ingestor's per-event field constraints.
 *
 * An event that breaks one of these is rejected by the ingestor and never
 * billed. The server reports it per event (`errors[]` in the batch response,
 * indexed), so the rest of the batch survives — but the SDK sends in the
 * background, so that report reaches nobody: the usage is simply gone. Checking
 * the same limits at `track()` reports the problem where it happens: the event
 * is not buffered or sent, it is counted in `droppedCount`, WARN-logged with
 * the field, the limit and the offending value, and handed to the opt-in
 * `onDrop` hook with reason `'invalid'`. `track()` does not throw for it.
 *
 * Source: `dto/IngestUsageEventRequest` (aforo-nextgen-usage-ingestor-service) —
 * the `@Size` and `@Digits` bean constraints, which are compiled into the
 * server and therefore identical in every environment.
 *
 * Deliberately NOT mirrored here: the timestamp window (`max-age-days`,
 * `future-tolerance-minutes`) and the metadata cap (`max-metadata-bytes`) in
 * `validation/UsageEventValidator`. Each is a per-environment property — a
 * tenant may raise `max-age-days` to 365 for backfills — so enforcing the
 * default here would make the SDK refuse usage its own server would accept and
 * bill. Refusing real usage is a worse failure than the rejection it prevents.
 * Only `occurredAt`'s shape is checked, since a malformed timestamp is invalid
 * under every configuration.
 *
 * The limit check never truncates or rounds a value the caller set — that would
 * change what is billed. The offending event is dropped instead (reason
 * `'invalid'`), naming the field, the limit, and the offending value.
 *
 * The one exception is a label the SDK itself reads off an incoming request
 * (the middlewares' `endpointPath` and `httpMethod`): dropping there would let
 * an API consumer avoid metering by sending an over-long path. Those are cut to
 * the limit where they are derived (`truncateRequestLabel`) and the event is
 * still sent.
 */

/** Maximum characters the ingestor accepts per string field (`@Size(max = ...)`). */
export const MAX_LENGTHS = {
  customerId: 64,
  metricName: 255,
  idempotencyKey: 255,
  productType: 20,
  traceId: 128,
  spanId: 32,
  sessionId: 64,
  agentId: 36,
  toolName: 64,
  capabilityName: 64,
  endpointPath: 512,
  httpMethod: 16,
  subscriptionId: 64,
  grpcService: 255,
  grpcMethod: 128,
  gqlOperationName: 255,
  wsConnectionId: 64,
  mqttTopic: 500,
  mqttClientId: 128,
} as const;

/** `@Digits(integer = 14, fraction = 6)` — `usage_events.quantity` is NUMERIC(20,6). */
export const MAX_QUANTITY_INTEGER_DIGITS = 14;
export const MAX_QUANTITY_DECIMAL_PLACES = 6;




/**
 * ISO-8601 date-time, the shape Jackson can read into an `Instant`. The zone
 * designator is optional here: the ingestor's example values all carry `Z`, but
 * an offset-less value is not provably rejected, and falsely rejecting one
 * would drop a billable event.
 */
const ISO_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?([Zz]|[+-]\d{2}:?\d{2})?$/;

/** Fields whose length the ingestor caps, checked when the caller sets them. */
type LengthCheckedField = keyof typeof MAX_LENGTHS;

/**
 * Length as the ingestor counts it: `String.length()` in Java is UTF-16 code
 * units, which is exactly what `String.prototype.length` returns.
 */
function lengthOf(value: string): number {
  return value.length;
}

/**
 * Cut `value` to at most `max` UTF-16 code units — how the ingestor counts —
 * without leaving half a surrogate pair at the end.
 */
export function truncateToLimit(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = Math.max(0, max);
  const last = end > 0 ? value.charCodeAt(end - 1) : 0;
  // A high surrogate at the cut means its low half was cut off: drop it too.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

/** Labels already reported as truncated — one WARN per label name per process. */
const truncationWarned = new Set<string>();

/**
 * Bound a label the SDK derived from an incoming request to the ingestor's
 * limit for `field`. Logs one WARN per field per process. Not for values the
 * SDK caller sets: those are never altered (an over-long one drops the event).
 */
export function truncateRequestLabel(field: LengthCheckedField, value: string): string {
  const max = MAX_LENGTHS[field];
  if (typeof value !== 'string' || value.length <= max) return value;
  if (!truncationWarned.has(field)) {
    truncationWarned.add(field);
    console.warn(
      `[aforo] ${field} taken from the request was longer than the ingestor's limit and was `
      + `truncated to ${max} characters; the event is still sent. Logged once per label.`,
    );
  }
  return truncateToLimit(value, max);
}

/** Test hook: forget which labels were already reported as truncated. */
export function resetTruncationWarnings(): void {
  truncationWarned.clear();
}

function lengthError(field: LengthCheckedField, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value);
  const max = MAX_LENGTHS[field];
  const len = lengthOf(text);
  if (len <= max) return null;
  return `${field} is ${len} characters, exceeding the ingestor's ${max}-character limit `
    + `(value starts "${text.slice(0, 80)}"). Shorten it — the SDK will not truncate it, `
    + 'because a truncated id bills the wrong thing.';
}

/**
 * Integer and decimal digit counts as the ingestor's `@Digits` sees them, i.e.
 * as `BigDecimal` reads the number the SDK puts on the wire:
 * `integerDigits = precision - scale`, `decimalPlaces = max(scale, 0)`.
 *
 * Works from the serialized text so exponent notation (`1e+21`, which
 * `JSON.stringify` emits for large numbers) is counted the same way the server
 * will count it.
 */
export function quantityDigits(serialized: string): { integerDigits: number; decimalPlaces: number } {
  const match = /^[+-]?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(serialized.trim());
  if (!match) return { integerDigits: 0, decimalPlaces: 0 };
  const intPart = match[1] ?? '';
  const fracPart = match[2] ?? '';
  const exponent = match[3] ? parseInt(match[3], 10) : 0;

  const digits = (intPart + fracPart).replace(/^0+/, '');
  const precision = digits.length === 0 ? 1 : digits.length;
  const scale = fracPart.length - exponent;

  return { integerDigits: precision - scale, decimalPlaces: Math.max(scale, 0) };
}

function quantityError(quantity: number): string | null {
  // JSON.stringify is what the transport uses, so this is the exact text the
  // ingestor will parse into the BigDecimal that @Digits inspects.
  const serialized = JSON.stringify(quantity);
  const { integerDigits, decimalPlaces } = quantityDigits(String(serialized));

  if (integerDigits > MAX_QUANTITY_INTEGER_DIGITS) {
    return `quantity ${serialized} has ${integerDigits} integer digits, exceeding the ingestor's `
      + `limit of ${MAX_QUANTITY_INTEGER_DIGITS} (usage_events.quantity is NUMERIC(20,6)).`;
  }
  if (decimalPlaces > MAX_QUANTITY_DECIMAL_PLACES) {
    return `quantity ${serialized} has ${decimalPlaces} decimal places, exceeding the ingestor's `
      + `limit of ${MAX_QUANTITY_DECIMAL_PLACES}. Round it yourself before tracking — the SDK will `
      + 'not round it, because that would change the quantity you are billed for.';
  }
  return null;
}

function occurredAtError(occurredAt: string): string | null {
  if (!ISO_DATE_TIME.test(occurredAt)) {
    return `occurredAt "${String(occurredAt).slice(0, 80)}" is not an ISO-8601 timestamp `
      + '(expected e.g. "2026-03-01T14:30:00Z").';
  }
  if (Number.isNaN(Date.parse(occurredAt))) {
    return `occurredAt "${String(occurredAt).slice(0, 80)}" is not a valid date.`;
  }
  return null;
}

/** The already-resolved event fields the limits apply to. */
export interface LimitCheckedEvent {
  customerId?: unknown;
  metricName?: unknown;
  quantity: number;
  idempotencyKey?: unknown;
  occurredAt: string;
  productType?: unknown;
  endpointPath?: unknown;
  httpMethod?: unknown;
  traceId?: unknown;
  spanId?: unknown;
  sessionId?: unknown;
  agentId?: unknown;
  toolName?: unknown;
  capabilityName?: unknown;
  subscriptionId?: unknown;
  grpcService?: unknown;
  grpcMethod?: unknown;
  gqlOperationName?: unknown;
  wsConnectionId?: unknown;
  mqttTopic?: unknown;
  mqttClientId?: unknown;
}

/**
 * Describe the first ingestor constraint this event breaks, or `null` when it
 * would be accepted. `AforoClient.track()` uses it to drop an invalid event
 * (reason `'invalid'`) before it is buffered.
 */
export function describeLimitViolation(event: LimitCheckedEvent): string | null {
  if (event.idempotencyKey !== undefined && event.idempotencyKey !== null
      && !String(event.idempotencyKey).trim()) {
    return 'idempotencyKey must not be blank when provided.';
  }

  for (const field of Object.keys(MAX_LENGTHS) as LengthCheckedField[]) {
    const problem = lengthError(field, (event as unknown as Record<string, unknown>)[field]);
    if (problem) return problem;
  }

  const quantityProblem = quantityError(event.quantity);
  if (quantityProblem) return quantityProblem;

  return occurredAtError(event.occurredAt);
}
