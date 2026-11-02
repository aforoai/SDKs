package com.aforo.testsupport;

import com.sun.net.httpserver.HttpExchange;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.zip.GZIPInputStream;

/**
 * Request bodies as usage-ingestor reads them (wave 8, G269): the transport core sends
 * batches of 1 KiB or more with Content-Encoding: gzip, and the ingestor decodes them.
 */
public final class RequestBodies {
    private RequestBodies() {
    }

    /** The decoded request body. */
    public static byte[] read(HttpExchange exchange) throws IOException {
        byte[] raw = exchange.getRequestBody().readAllBytes();
        String encoding = exchange.getRequestHeaders().getFirst("Content-Encoding");
        if (encoding == null || !encoding.trim().equalsIgnoreCase("gzip")) {
            return raw;
        }
        try (GZIPInputStream in = new GZIPInputStream(new ByteArrayInputStream(raw))) {
            return in.readAllBytes();
        }
    }
}
