/**
 * @file Incremental Server-Sent Events parser.
 *
 * Network chunks do not line up with events: one event can arrive in several
 * chunks and one chunk can hold several events. The parser keeps the partial
 * tail between calls, and joins multi-line `data:` fields with "\n" as the SSE
 * spec says. Each event comes back with its raw text so a proxy can forward it
 * unchanged.
 */

export interface SseEvent {
  /** `event:` field; undefined means the default type ("message"). */
  event?: string;
  /** `data:` lines joined with "\n"; undefined when the event had none. */
  data?: string;
  /** The event exactly as received, including its terminating blank line. */
  raw: string;
}

export class SseParser {
  private buffer = '';

  /** Feed a chunk; returns the events it completed. */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    for (;;) {
      const match = /\r\n\r\n|\n\n|\r\r/.exec(this.buffer);
      if (!match) break;
      const end = match.index + match[0].length;
      const raw = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end);
      events.push(parseEvent(raw));
    }
    return events;
  }

  /** Bytes held while waiting for the end of an event. */
  get pending(): number {
    return this.buffer.length;
  }
}

function parseEvent(raw: string): SseEvent {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split(/\r\n|\n|\r/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return { ...(event !== undefined ? { event } : {}), ...(data.length ? { data: data.join('\n') } : {}), raw };
}

/** One SSE `message` event carrying `json`. */
export function sseMessage(json: string): string {
  return `event: message\n${json.split('\n').map((l) => `data: ${l}`).join('\n')}\n\n`;
}
