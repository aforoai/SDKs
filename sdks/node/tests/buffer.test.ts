import { RingBuffer } from '../src/buffer';

describe('RingBuffer', () => {
  const makeEvent = (id: number) => ({
    customerId: `cust_${id}`,
    metricName: 'api_calls',
    quantity: 1,
    idempotencyKey: `key_${id}`,
    occurredAt: new Date().toISOString(),
  });

  it('should push and drain events', () => {
    const buf = new RingBuffer(10);
    buf.push(makeEvent(1));
    buf.push(makeEvent(2));
    buf.push(makeEvent(3));

    expect(buf.size).toBe(3);
    expect(buf.isEmpty).toBe(false);

    const drained = buf.drain();
    expect(drained).toHaveLength(3);
    expect(drained[0].customerId).toBe('cust_1');
    expect(drained[2].customerId).toBe('cust_3');
    expect(buf.size).toBe(0);
    expect(buf.isEmpty).toBe(true);
  });

  it('should drop oldest on overflow', () => {
    const buf = new RingBuffer(3);
    expect(buf.push(makeEvent(1))).toBe(true);
    expect(buf.push(makeEvent(2))).toBe(true);
    expect(buf.push(makeEvent(3))).toBe(true);
    expect(buf.isFull).toBe(true);

    // Overflow — drops event 1
    expect(buf.push(makeEvent(4))).toBe(false);
    expect(buf.size).toBe(3);

    const drained = buf.drain();
    expect(drained[0].customerId).toBe('cust_2');
    expect(drained[1].customerId).toBe('cust_3');
    expect(drained[2].customerId).toBe('cust_4');
  });

  it('should drainUpTo a max number of events', () => {
    const buf = new RingBuffer(100);
    for (let i = 0; i < 10; i++) buf.push(makeEvent(i));

    const batch1 = buf.drainUpTo(3);
    expect(batch1).toHaveLength(3);
    expect(batch1[0].customerId).toBe('cust_0');
    expect(buf.size).toBe(7);

    const batch2 = buf.drainUpTo(5);
    expect(batch2).toHaveLength(5);
    expect(batch2[0].customerId).toBe('cust_3');
    expect(buf.size).toBe(2);
  });

  it('should handle drain on empty buffer', () => {
    const buf = new RingBuffer(10);
    expect(buf.drain()).toEqual([]);
    expect(buf.drainUpTo(5)).toEqual([]);
  });

  it('should throw on invalid capacity', () => {
    expect(() => new RingBuffer(0)).toThrow('capacity must be >= 1');
    expect(() => new RingBuffer(-5)).toThrow('capacity must be >= 1');
  });

  it('should handle wrap-around correctly', () => {
    const buf = new RingBuffer(4);
    buf.push(makeEvent(1));
    buf.push(makeEvent(2));
    buf.drainUpTo(2); // head wraps forward

    buf.push(makeEvent(3));
    buf.push(makeEvent(4));
    buf.push(makeEvent(5));
    buf.push(makeEvent(6)); // tail wraps around

    expect(buf.size).toBe(4);
    const drained = buf.drain();
    expect(drained.map(e => e.customerId)).toEqual([
      'cust_3', 'cust_4', 'cust_5', 'cust_6',
    ]);
  });
});
