import { gunzipSync } from 'zlib';

/**
 * The JSON a fake fetch received. The transport core gzips bodies of 1 KiB or more
 * (wave 8, G269) and passes them as bytes; plain JSON stays a string.
 */
export function bodyJson(init: { body?: unknown }): any {
  const body = init.body as any;
  if (typeof body === 'string') return JSON.parse(body);
  return JSON.parse(gunzipSync(Buffer.from(body)).toString('utf8'));
}

/** A raw request body as text, gunzipped when the client sent Content-Encoding: gzip. */
export function requestText(contentEncoding: string | string[] | undefined, raw: Buffer): string {
  const coding = String(contentEncoding ?? '').trim().toLowerCase();
  return (coding === 'gzip' ? gunzipSync(raw) : raw).toString('utf8');
}
