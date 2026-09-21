package com.aforo.metering.spring;

import com.aforo.metering.AforoClient;
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
import java.util.Objects;

/**
 * Servlet filter that captures API usage events after each request.
 *
 * <p>Runs AFTER {@code filterChain.doFilter()} returns — the response has
 * already been committed, so this adds zero latency to the API call.</p>
 *
 * <h2>Metric</h2>
 * Each request is recorded against {@link #metricName(String) a fixed metric}
 * (default {@value #DEFAULT_METRIC_NAME}) or the result of a
 * {@link #metricNameResolver(MetricNameResolver) resolver}. The metric must exist
 * in the tenant's Aforo catalog: the ingestor rejects unknown metrics, and
 * because it validates a batch as a whole, one such event fails the entire
 * batch. The old default, {@code "METHOD /path"}, is a name no catalog contains.
 *
 * <h2>Customer</h2>
 * The customer id comes from a {@link #customerIdResolver(CustomerIdResolver)
 * resolver} if set, otherwise from the {@link #customerIdHeader(String)
 * customer header} (default {@value #DEFAULT_CUSTOMER_ID_HEADER}). The
 * authenticated principal's name is used (ahead of the header) only when
 * explicitly enabled with {@link #usePrincipalAsCustomerId(boolean)}: a login
 * name is rarely an Aforo customer id. The caller's {@code X-Api-Key} header is never used — it is a
 * secret, not an id. Requests with no customer are not metered.
 *
 * <p>{@code OPTIONS} (CORS preflight) requests are never metered.</p>
 */
public class AforoServletFilter implements Filter {

    /** Metric recorded when none is configured. Must exist in your Aforo catalog. */
    public static final String DEFAULT_METRIC_NAME = "api_calls";

    /** Header read for the customer id when no resolver is configured. */
    public static final String DEFAULT_CUSTOMER_ID_HEADER = "X-Customer-Id";

    private static final List<String> DEFAULT_EXCLUDE_PATHS = List.of(
            "/health", "/ready", "/metrics", "/favicon.ico", "/actuator");

    /** Derives the metric name for a request. Returning null/blank uses the fixed metric name. */
    @FunctionalInterface
    public interface MetricNameResolver {
        String resolve(HttpServletRequest request, HttpServletResponse response);
    }

    /** Derives the Aforo customer id for a request. Returning null/blank skips metering it. */
    @FunctionalInterface
    public interface CustomerIdResolver {
        String resolve(HttpServletRequest request);
    }

    private final AforoClient client;
    private final List<String> excludePaths;
    private String metricName = DEFAULT_METRIC_NAME;
    private MetricNameResolver metricNameResolver;
    private String customerIdHeader = DEFAULT_CUSTOMER_ID_HEADER;
    private CustomerIdResolver customerIdResolver;
    private boolean usePrincipalAsCustomerId;

    public AforoServletFilter(AforoClient client) {
        this(client, DEFAULT_EXCLUDE_PATHS);
    }

    public AforoServletFilter(AforoClient client, List<String> excludePaths) {
        this.client = client;
        this.excludePaths = excludePaths;
    }

    /** Fixed metric recorded per request. Default {@value #DEFAULT_METRIC_NAME}. */
    public AforoServletFilter metricName(String metricName) {
        this.metricName = isBlank(metricName) ? DEFAULT_METRIC_NAME : metricName;
        return this;
    }

    /** Per-request metric; takes precedence over {@link #metricName(String)}. */
    public AforoServletFilter metricNameResolver(MetricNameResolver resolver) {
        this.metricNameResolver = resolver;
        return this;
    }

    /** Header carrying the Aforo customer id. Default {@value #DEFAULT_CUSTOMER_ID_HEADER}. */
    public AforoServletFilter customerIdHeader(String header) {
        this.customerIdHeader = isBlank(header) ? DEFAULT_CUSTOMER_ID_HEADER : header;
        return this;
    }

    /** Per-request customer id; takes precedence over the header and principal. */
    public AforoServletFilter customerIdResolver(CustomerIdResolver resolver) {
        this.customerIdResolver = resolver;
        return this;
    }

    /**
     * Opt in to using {@code getUserPrincipal().getName()} as the customer id
     * (ahead of the customer header). Off by default: a principal name is usually
     * a login, not an Aforo customer id.
     */
    public AforoServletFilter usePrincipalAsCustomerId(boolean enabled) {
        this.usePrincipalAsCustomerId = enabled;
        return this;
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

            // CORS preflights are browser protocol, not billable calls, and carry
            // no credentials -- so they never have a customer.
            if ("OPTIONS".equalsIgnoreCase(req.getMethod())) return;

            String path = req.getRequestURI();

            // Check exclusions
            if (excludePaths.stream().anyMatch(path::startsWith)) return;

            String customerId = extractCustomerId(req);
            if (customerId == null) return;

            client.track(TrackEvent.builder(customerId, resolveMetricName(req, res))
                    .quantity(1)
                    .metadata(Map.of("gateway", "java-servlet", "status", res.getStatus()))
                    .build());

        } catch (Exception e) {
            // Never let metering affect the API, but log for debugging
            java.util.logging.Logger.getLogger(AforoServletFilter.class.getName())
                    .log(java.util.logging.Level.FINE, "Metering capture failed", e);
        }
    }

    private String resolveMetricName(HttpServletRequest req, HttpServletResponse res) {
        if (metricNameResolver != null) {
            String resolved = metricNameResolver.resolve(req, res);
            if (!isBlank(resolved)) return resolved;
        }
        return metricName;
    }

    private String extractCustomerId(HttpServletRequest req) {
        if (customerIdResolver != null) {
            return trimToNull(customerIdResolver.resolve(req));
        }
        // An authenticated principal, when opted in, outranks a client-supplied header.
        if (usePrincipalAsCustomerId && req.getUserPrincipal() != null) {
            String principal = trimToNull(req.getUserPrincipal().getName());
            if (principal != null) return principal;
        }
        return trimToNull(req.getHeader(customerIdHeader));
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }

    private static String trimToNull(String s) {
        return isBlank(s) ? null : Objects.requireNonNull(s).trim();
    }

    @Override
    public void init(FilterConfig filterConfig) {}

    @Override
    public void destroy() {
        client.close();
    }
}
