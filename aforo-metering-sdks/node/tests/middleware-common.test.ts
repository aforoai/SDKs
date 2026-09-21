import { DEFAULT_METRIC_NAME, firstNonEmpty, isPreflight, resolveMetricName } from '../src/middleware/common';

describe('middleware common helpers', () => {
  it('defaults the metric to api_calls', () => {
    expect(DEFAULT_METRIC_NAME).toBe('api_calls');
    expect(resolveMetricName({ apiKey: 'k' }, {}, {})).toBe('api_calls');
    expect(resolveMetricName({ apiKey: 'k', metricName: '' }, {}, {})).toBe('api_calls');
  });

  it('prefers a resolver, then a fixed name', () => {
    expect(resolveMetricName({ apiKey: 'k', metricName: 'sms_sent' }, {}, {})).toBe('sms_sent');
    expect(resolveMetricName({ apiKey: 'k', metricName: (r: any) => r.m }, { m: 'otp' }, {})).toBe('otp');
    // A resolver that returns nothing falls back to the default rather than sending ""
    expect(resolveMetricName({ apiKey: 'k', metricName: () => '' }, {}, {})).toBe('api_calls');
  });

  it('detects preflights case-insensitively', () => {
    expect(isPreflight('OPTIONS')).toBe(true);
    expect(isPreflight('options')).toBe(true);
    expect(isPreflight('GET')).toBe(false);
    expect(isPreflight(undefined)).toBe(false);
  });

  it('picks the first non-blank candidate', () => {
    expect(firstNonEmpty(undefined, null, '', '  ', 'a', 'b')).toBe('a');
    expect(firstNonEmpty(['x', 'y'])).toBe('x');
    expect(firstNonEmpty(42)).toBe('42');
    expect(firstNonEmpty()).toBeNull();
  });
});
