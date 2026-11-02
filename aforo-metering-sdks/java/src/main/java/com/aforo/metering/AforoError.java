package com.aforo.metering;

import java.util.List;
import java.util.Locale;

/**
 * A delivery problem reported to {@link AforoOptions#onError}. Branch on {@link #kind()},
 * never on the message. The message never contains the API key.
 */
public final class AforoError {

    /** What happened. */
    public enum Kind {
        /** The ingestor was unreachable, answered 408/429/5xx or a redirect after every retry. The events stay queued and are resent. */
        OUTAGE,
        /** The ingestor answered 401/403: the API key is wrong or revoked. The events stay queued and are resent. */
        AUTH,
        /** The ingestor refused the events; they are dropped. */
        REJECTED,
        /** The events were still queued at the shutdown deadline; they are dropped. */
        SHUTDOWN,
        /** The event was tracked after {@code close()}; it is dropped. */
        CLOSED;

        /** The contract spelling ({@code outage}, {@code auth}, ...). */
        public String wireName() {
            return name().toLowerCase(Locale.ROOT);
        }
    }

    private final Kind kind;
    private final String message;
    private final List<ResolvedEvent> events;
    private final int status;

    AforoError(Kind kind, String message, List<ResolvedEvent> events, int status) {
        this.kind = kind;
        this.message = message;
        this.events = List.copyOf(events);
        this.status = status;
    }

    public Kind kind() { return kind; }
    public String message() { return message; }
    /** The events concerned: the queued ones for OUTAGE/AUTH, the dropped ones otherwise (may be empty). */
    public List<ResolvedEvent> events() { return events; }
    /** HTTP status of the answer that caused the report, or 0 when there was none. */
    public int status() { return status; }
    /** True when the events are still queued and will be resent. */
    public boolean willRetry() { return kind == Kind.OUTAGE || kind == Kind.AUTH; }

    @Override
    public String toString() {
        return "AforoError{kind=" + kind.wireName() + ", status=" + status + ", events=" + events.size()
                + ", message=" + message + "}";
    }
}
