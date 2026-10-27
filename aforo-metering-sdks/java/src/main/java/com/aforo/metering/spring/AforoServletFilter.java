package com.aforo.metering.spring;

import com.aforo.metering.AforoClient;
import com.aforo.metering.AforoOptions;
import com.aforo.metering.PathNormalizer;
import com.aforo.metering.RequestLabels;
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
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.logging.Logger;

/**
 * Servlet filter that captures API usage events after each request.
 *
 * <p>Runs AFTER {@code filterChain.doFilter()} returns — the response has
 * already been committed, so this adds zero latency to the API call.</p>
 *
 * <h2>Metric</h2>
 * Each request is recorded against {@link Builder#metricName(String) a fixed metric}
 * (default {@value #DEFAULT_METRIC_NAME}) or the result of a
 * {@link Builder#metricNameResolver(MetricNameResolver) resolver}. The metric must exist
 * in the tenant's Aforo catalog: the ingestor rejects unknown metrics, and
 * because it validates a batch as a whole, one such event fails the entire
 * batch. The old default, {@code "METHOD /path"}, is a name no catalog contains.
 *
 * <h2>Customer</h2>
 * The customer id must come from an identity you trust. Build the filter with a
 * {@link Builder#customerIdResolver(CustomerIdResolver) resolver} that reads it
 * from your authentication (session, JWT subject, API-key lookup), or opt in to
 * {@link Builder#usePrincipalAsCustomerId(boolean) the authenticated principal's
 * name}. Reading the {@link Builder#customerIdHeader(String) customer header}
 * (default {@value #DEFAULT_CUSTOMER_ID_HEADER}) needs
 * {@link Builder#trustCustomerHeader(boolean) trustCustomerHeader(true)}: the
 * caller of your API controls that header, so anyone could bill usage to another
 * customer. With none of the three, {@link Builder#build()} throws. A request for
 * which no customer is found is not sent; it is counted and reported to
 * {@code onDrop} as {@code INVALID}. The request itself always goes through.
 *
 * <p>{@code OPTIONS} (CORS preflight) requests are never metered.</p>
 *
 * <p>Each event carries top-level {@code endpointPath} (the matched Spring MVC
 * route pattern, else the normalized request path, without query string),
 * {@code httpMethod}, {@code statusCode}, {@code responseTimeMs}, and
 * {@code productType} ({@link Builder#productType(String)}, else the client default).</p>
 *
 * <p>{@code endpointPath} and {@code httpMethod} come from the request. A value
 * over the ingestor's limit (512 / 16 characters) is truncated and the event is
 * still sent; one warning is logged per label per filter. The customer id and
 * the metric name are never truncated — an over-long one drops the event.</p>
 */
public class AforoServletFilter implements Filter {

    /** Metric recorded when none is configured. Must exist in your Aforo catalog. */
    public static final String DEFAULT_METRIC_NAME = "api_calls";

    /** Header read for the customer id when {@link Builder#trustCustomerHeader(boolean)} is on. */
    public static final String DEFAULT_CUSTOMER_ID_HEADER = "X-Customer-Id";

    /** Ingestor limit on {@code endpointPath}. */
    static final int MAX_ENDPOINT_PATH_LENGTH = 512;

    /** Ingestor limit on {@code httpMethod}. */
    static final int MAX_HTTP_METHOD_LENGTH = 16;

    private static final Logger LOG = Logger.getLogger(AforoServletFilter.class.getName());

    /** Labels already reported as truncated — one warning per label per filter. */
    private final Set<String> truncationWarned = ConcurrentHashMap.newKeySet();

    private static final String BEST_MATCHING_PATTERN_ATTRIBUTE =
            "org.springframework.web.servlet.HandlerMapping.bestMatchingPattern";

    private static final List<String> DEFAULT_EXCLUDE_PATHS = List.of(
            "/health", "/ready", "/metrics", "/favicon.ico", "/actuator");

    /** Derives the metric name for a request. Returning null/blank uses the fixed metric name. */
    @FunctionalInterface
    public interface MetricNameResolver {
        String resolve(HttpServletRequest request, HttpServletResponse response);
    }

    /** Derives the Aforo customer id for a request from your authentication. Null/blank: the event is dropped as INVALID. */
    @FunctionalInterface
    public interface CustomerIdResolver {
        String resolve(HttpServletRequest request);
    }

    private final AforoClient client;
    private final List<String> excludePaths;
    private final String metricName;
    private final MetricNameResolver metricNameResolver;
    private final String customerIdHeader;
    private final CustomerIdResolver customerIdResolver;
    private final boolean trustCustomerHeader;
    private final boolean usePrincipalAsCustomerId;
    private final String productType;
    private final boolean closeClientOnDestroy;

    private AforoServletFilter(Builder b) {
        this.client = b.client;
        this.excludePaths = List.copyOf(b.excludePaths);
        this.metricName = b.metricName;
        this.metricNameResolver = b.metricNameResolver;
        this.customerIdHeader = b.customerIdHeader;
        this.customerIdResolver = b.customerIdResolver;
        this.trustCustomerHeader = b.trustCustomerHeader;
        this.usePrincipalAsCustomerId = b.usePrincipalAsCustomerId;
        this.productType = b.productType;
        this.closeClientOnDestroy = b.closeClientOnDestroy;
    }

    /** Start building a filter that records into {@code client}. */
    public static Builder builder(AforoClient client) {
        return new Builder(client);
    }

    /** Builds an {@link AforoServletFilter}; {@link #build()} checks the customer source. */
    public static final class Builder {
        private final AforoClient client;
        private List<String> excludePaths = DEFAULT_EXCLUDE_PATHS;
        private String metricName = DEFAULT_METRIC_NAME;
        private MetricNameResolver metricNameResolver;
        private String customerIdHeader = DEFAULT_CUSTOMER_ID_HEADER;
        private CustomerIdResolver customerIdResolver;
        private boolean trustCustomerHeader;
        private boolean usePrincipalAsCustomerId;
        private String productType;
        private boolean closeClientOnDestroy = true;

        private Builder(AforoClient client) {
            if (client == null) throw new IllegalArgumentException("client is required");
            this.client = client;
        }

        /** Path prefixes never metered. Default: /health, /ready, /metrics, /favicon.ico, /actuator. */
        public Builder excludePaths(List<String> excludePaths) {
            this.excludePaths = excludePaths == null ? List.of() : excludePaths;
            return this;
        }

        /** Fixed metric recorded per request. Default {@value #DEFAULT_METRIC_NAME}. */
        public Builder metricName(String metricName) {
            this.metricName = isBlank(metricName) ? DEFAULT_METRIC_NAME : metricName;
            return this;
        }

        /** Per-request metric; takes precedence over {@link #metricName(String)}. */
        public Builder metricNameResolver(MetricNameResolver resolver) {
            this.metricNameResolver = resolver;
            return this;
        }

        /**
         * Reads the customer id from your authenticated identity. Takes precedence
         * over the principal and the header. Returning null/blank drops that
         * request's event as {@code INVALID}.
         */
        public Builder customerIdResolver(CustomerIdResolver resolver) {
            this.customerIdResolver = resolver;
            return this;
        }

        /**
         * Opt in to reading the customer id from {@link #customerIdHeader(String) the
         * customer header}. Only do this when something in front of your app (a gateway
         * that authenticates the caller) sets the header and strips any value the caller
         * sent.
         */
        public Builder trustCustomerHeader(boolean trust) {
            this.trustCustomerHeader = trust;
            return this;
        }

        /** Header read when {@link #trustCustomerHeader(boolean)} is on. Default {@value #DEFAULT_CUSTOMER_ID_HEADER}. */
        public Builder customerIdHeader(String header) {
            this.customerIdHeader = isBlank(header) ? DEFAULT_CUSTOMER_ID_HEADER : header;
            return this;
        }

        /**
         * Opt in to using {@code getUserPrincipal().getName()} as the customer id
         * (ahead of the header). Use it when the principal name is the Aforo customer id.
         */
        public Builder usePrincipalAsCustomerId(boolean enabled) {
            this.usePrincipalAsCustomerId = enabled;
            return this;
        }

        /**
         * Product type for events recorded by this filter. {@code null} (default)
         * uses the client's {@link AforoOptions#productType(String)}.
         */
        public Builder productType(String productType) {
            this.productType = AforoOptions.normalizeProductType(productType);
            return this;
        }

        /**
         * Close the client when the servlet container destroys the filter (default
         * {@code true}). The Spring Boot auto-configuration turns this off because
         * Spring closes the client bean itself.
         */
        public Builder closeClientOnDestroy(boolean close) {
            this.closeClientOnDestroy = close;
            return this;
        }

        /**
         * @throws IllegalStateException when no customer source is configured: set
         *         {@link #customerIdResolver}, {@link #usePrincipalAsCustomerId} or
         *         {@link #trustCustomerHeader}
         */
        public AforoServletFilter build() {
            if (customerIdResolver == null && !usePrincipalAsCustomerId && !trustCustomerHeader) {
                throw new IllegalStateException(MISSING_CUSTOMER_SOURCE);
            }
            return new AforoServletFilter(this);
        }
    }

    /** Message for a filter built without a customer source. */
    public static final String MISSING_CUSTOMER_SOURCE = "AforoServletFilter needs to know which customer each"
            + " request belongs to. Set customerIdResolver(...) to read it from your authenticated identity"
            + " (session, JWT subject, API-key lookup), or usePrincipalAsCustomerId(true) when the principal"
            + " name is the Aforo customer id. trustCustomerHeader(true) reads the " + DEFAULT_CUSTOMER_ID_HEADER
            + " header instead; only use it when a gateway in front of your app sets that header, because"
            + " callers can otherwise bill usage to any customer.";

    @Override
    public void doFilter(ServletRequest servletRequest, ServletResponse servletResponse,
                         FilterChain filterChain) throws IOException, ServletException {

        long startNanos = System.nanoTime();
        filterChain.doFilter(servletRequest, servletResponse);
        long responseTimeMs = (System.nanoTime() - startNanos) / 1_000_000L;

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

            // A request with no customer is reported (INVALID) by the client, never blocked.
            String customerId = extractCustomerId(req);

            client.track(TrackEvent.builder(customerId, resolveMetricName(req, res))
                    .quantity(1)
                    .productType(productType)
                    .endpointPath(endpointPath(req, path))
                    .httpMethod(bounded("httpMethod", req.getMethod(), MAX_HTTP_METHOD_LENGTH))
                    .statusCode(res.getStatus())
                    .responseTimeMs(responseTimeMs)
                    .metadata(Map.of("gateway", "java-servlet", "status", res.getStatus()))
                    .build());

        } catch (Exception e) {
            // Never let metering affect the API, but log for debugging
            java.util.logging.Logger.getLogger(AforoServletFilter.class.getName())
                    .log(java.util.logging.Level.FINE, "Metering capture failed", e);
        }
    }

    /** Route pattern when Spring MVC matched one, else the normalized path; no query, capped. */
    private String endpointPath(HttpServletRequest req, String path) {
        Object pattern = req.getAttribute(BEST_MATCHING_PATTERN_ATTRIBUTE);
        String normalized = PathNormalizer.normalize(path, pattern instanceof String s ? s : null);
        int q = normalized.indexOf('?');
        if (q >= 0) normalized = normalized.substring(0, q);
        return bounded("endpointPath", normalized, MAX_ENDPOINT_PATH_LENGTH);
    }

    /** A request-derived label cut to the ingestor's limit; warns once per label. */
    private String bounded(String label, String value, int max) {
        if (value == null || value.length() <= max) return value;
        if (truncationWarned.add(label)) {
            LOG.warning("[aforo] " + label + " from the request was longer than " + max
                    + " characters and was truncated to " + max + "; the event is still sent."
                    + " Later truncations of " + label + " are not logged.");
        }
        return RequestLabels.truncate(value, max);
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
        return trustCustomerHeader ? trimToNull(req.getHeader(customerIdHeader)) : null;
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
        if (closeClientOnDestroy) client.close();
    }
}
