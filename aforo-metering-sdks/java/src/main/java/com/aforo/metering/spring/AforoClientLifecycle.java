package com.aforo.metering.spring;

import com.aforo.metering.AforoClient;
import org.springframework.context.SmartLifecycle;

/**
 * Closes the {@link AforoClient} in Spring's stop phase, so queued usage is sent
 * (bounded by {@code aforo.shutdown-timeout-ms}) while the application context is
 * still up, instead of racing a JVM shutdown hook.
 *
 * <p>Spring stops lifecycles from the highest phase down, and beans that share a phase
 * in no defined order. Spring Boot (3.2 through 3.5) finishes graceful shutdown at
 * {@code DEFAULT_PHASE - 1024} and stops the embedded web server at
 * {@code DEFAULT_PHASE - 2048}. This bean uses {@code DEFAULT_PHASE - 3072}, so it
 * stops strictly after the server has finished its last requests and their usage is
 * in the queue before the client drains it.</p>
 */
public class AforoClientLifecycle implements SmartLifecycle {

    /** One step (1024) below the embedded web server's stop phase. */
    public static final int PHASE = SmartLifecycle.DEFAULT_PHASE - 3072;

    private final AforoClient client;
    private volatile boolean running;

    public AforoClientLifecycle(AforoClient client) {
        this.client = client;
    }

    @Override
    public void start() {
        running = true;
    }

    @Override
    public void stop() {
        running = false;
        client.close();
    }

    @Override
    public boolean isRunning() {
        return running;
    }

    @Override
    public int getPhase() {
        return PHASE;
    }
}
