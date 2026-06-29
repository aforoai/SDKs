package com.aforo.metering.spring;

import com.aforo.metering.AforoClient;
import com.aforo.metering.PathNormalizer;
import com.aforo.metering.TrackEvent;
import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.FilterConfig;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import java.io.IOException;
import java.util.List;
import java.util.Map;

/**
 * Servlet filter that captures API usage events after each request.
 *
 * <p>Runs AFTER {@code filterChain.doFilter()} returns — the response has
 * already been committed, so this adds zero latency to the API call.</p>
 */
public class AforoServletFilter implements Filter {

    private static final List<String> DEFAULT_EXCLUDE_PATHS = List.of(
            "/health", "/ready", "/metrics", "/favicon.ico", "/actuator");

    private final AforoClient client;
    private final List<String> excludePaths;

    public AforoServletFilter(AforoClient client) {
        this(client, DEFAULT_EXCLUDE_PATHS);
    }

    public AforoServletFilter(AforoClient client, List<String> excludePaths) {
        this.client = client;
        this.excludePaths = excludePaths;
    }

    @Override
    public void doFilter(ServletRequest servletRequest, ServletResponse servletResponse,
                         FilterChain filterChain) throws IOException, ServletException {

        filterChain.doFilter(servletRequest, servletResponse);

        // After response — capture event (non-blocking, fire-and-forget)
        try {
            if (!(servletRequest instanceof HttpServletRequest req)
                    || !(servletResponse instanceof HttpServletResponse res)) {
                return;
            }

            String path = req.getRequestURI();
            String method = req.getMethod();

            // Check exclusions
            if (excludePaths.stream().anyMatch(path::startsWith)) return;

            // Normalize path (Spring MVC sets the matched pattern as an attribute)
            Object patternAttr = req.getAttribute(
                    "org.springframework.web.servlet.HandlerMapping.bestMatchingPattern");
            String routeTemplate = patternAttr instanceof String s ? s : null;
            String normalized = PathNormalizer.normalize(path, routeTemplate);

            // Extract customer ID
            String customerId = extractCustomerId(req);
            if (customerId == null) return;

            client.track(TrackEvent.builder(customerId, method + " " + normalized)
                    .quantity(1)
                    .metadata(Map.of("gateway", "java-servlet", "status", res.getStatus()))
                    .build());

        } catch (Exception e) {
            // Never let metering affect the API, but log for debugging
            java.util.logging.Logger.getLogger(AforoServletFilter.class.getName())
                    .log(java.util.logging.Level.FINE, "Metering capture failed", e);
        }
    }

    private String extractCustomerId(HttpServletRequest req) {
        // 1. Spring Security principal
        if (req.getUserPrincipal() != null) {
            return req.getUserPrincipal().getName();
        }
        // 2. Custom header
        String customerHeader = req.getHeader("X-Customer-Id");
        if (customerHeader != null && !customerHeader.isBlank()) return customerHeader;
        // 3. API key header
        String apiKeyHeader = req.getHeader("X-Api-Key");
        if (apiKeyHeader != null && !apiKeyHeader.isBlank()) return apiKeyHeader;

        return null;
    }

    @Override
    public void init(FilterConfig filterConfig) {}

    @Override
    public void destroy() {
        client.close();
    }
}
