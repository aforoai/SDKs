/**
 * Fakes shared by this package's Jest suites. Lives outside `src/` so it is
 * never built into the published `dist/`.
 */

/**
 * A jest mock for mqtt.js `client.publish` that reports success the way
 * mqtt.js does: it calls the publish callback (the 4th argument, or the 3rd
 * when no options are passed) with no error. wrapMqttClient meters a PUBLISH
 * only from that callback, so a fake that never calls it meters nothing.
 */
export function ackingPublish(returnValue?: unknown): jest.Mock {
  return jest.fn((_topic: string, _message: unknown, opts?: unknown, cb?: unknown) => {
    const callback = typeof opts === 'function' ? opts : cb;
    if (typeof callback === 'function') callback(null, { cmd: 'publish' });
    return returnValue;
  });
}
