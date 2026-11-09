package com.aforo.metering.spring;

import com.aforo.metering.AforoClient;
import com.aforo.metering.AforoOptions;
import com.aforo.metering.PathNormalizer;
import com.aforo.metering.RequestLabels;
import com.aforo.metering.TrackEvent;
import jakarta.servlet.AsyncEvent;
import jakarta.servlet.AsyncListener;
import jakarta.servlet.DispatcherType;
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
 * already been committed, so this adds zero latency to the API call. An async
 * request (DeferredResult, Callable, {@code startAsync}) is metered when it
 * completes, with its final status and duration. A request whose handler throws
 * is metered with status 500 and the exception is rethrown. Only the REQUEST
 * dispatch is metered, so an ASYNC or ERROR re-dispatch never counts twice.</p>
 *
 * <h2>Metric</h2>
 * Each request is recorded against {@link Builder#metricName(String) a fixed metric}
 * (default {@value #DEFAULT_METRIC_NAME}) or the result of a
 * {@link Builder#metricNameResolver(MetricNameResolver) resolver}. The metric must exist
 * in the tenant's Aforo catalog: the ingestor rejects each event that names an
 * unknown metric (events are checked one by one, so the rest of the batch is
 * stored). The old default, {@code "METHOD /path"}, is a name no catalog contains.
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

    /**
     * Derives the metric name for a request. Returning null/blank uses the fixed metric name.
     * A resolver that throws drops that request's event as INVALID (counted, never thrown).
     */
    @FunctionalInterface
    public interface MetricNameResolver {
        String resolve(HttpServletRequest request, HttpServletResponse response);
    }

    /**
     * Derives the Aforo customer id for a request from your authentication. Null/blank, or an
     * exception: the event is dropped as INVALID and counted; the request is served as usual.
     */
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

        /**
         * Paths never metered. Default: /health, /ready, /metrics, /favicon.ico, /actuator. Each
         * entry {@code p} matches {@code p} and everything under {@code p + "/"}, on the path
         * without the context path: {@code /health} excludes {@code /health/live}, not
         * {@code /healthcare}.
         */
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

        // Only the first (REQUEST) pass of a request is metered: an ASYNC or ERROR re-dispatch
        // through this filter is the same billable call and must not be counted again.
        if (!(servletRequest instanceof HttpServletRequest req)
                || !(servletResponse instanceof HttpServletResponse res)
                || !isRequestDispatch(req) || !shouldMeter(req)) {
            filterChain.doFilter(servletRequest, servletResponse);
            return;
        }

        long startNanos = System.nanoTime();
        try {
            filterChain.doFilter(servletRequest, servletResponse);
        } catch (IOException | ServletException | RuntimeException | Error e) {
            // The handler failed: the container answers 500 (unless the response was already sent).
            int status = res.isCommitted() ? res.getStatus() : HttpServletResponse.SC_INTERNAL_SERVER_ERROR;
            meter(req, res, startNanos, status, resolveCustomerSafely(req));
            throw e;
        }

        if (isAsyncStarted(req)) {
            // The handler returned but the response is written later (DeferredResult, Callable,
            // startAsync): meter when the exchange completes, with its real status and duration.
            // The customer is resolved now, on the request thread, where the caller's security
            // context still is.
            Resolved customer = resolveCustomerSafely(req);
            try {
                req.getAsyncContext().addListener(new CompletionListener(req, res, startNanos, customer));
                return;
            } catch (RuntimeException e) {
                LOG.log(java.util.logging.Level.FINE, "[aforo] could not watch the async request; metering it now", e);
                meter(req, res, startNanos, res.getStatus(), customer);
                return;
            }
        }
        meter(req, res, startNanos, res.getStatus(), resolveCustomerSafely(req));
    }

    /** Meters an async request once, when it completes (after a timeout or an error too). */
    private final class CompletionListener implements AsyncListener {
        private final HttpServletRequest req;
        private final HttpServletResponse res;
        private final long startNanos;
        private final Resolved customer;
        private final java.util.concurrent.atomic.AtomicBoolean done = new java.util.concurrent.atomic.AtomicBoolean();

        CompletionListener(HttpServletRequest req, HttpServletResponse res, long startNanos, Resolved customer) {
            this.req = req;
            this.res = res;
            this.startNanos = startNanos;
            this.customer = customer;
        }

        @Override
        public void onComplete(AsyncEvent event) {
            if (done.compareAndSet(false, true)) meter(req, res, startNanos, res.getStatus(), customer);
        }

        @Override public void onTimeout(AsyncEvent event) { }
        @Override public void onError(AsyncEvent event) { }

        @Override
        public void onStartAsync(AsyncEvent event) {
            // A re-dispatch started async again: listeners must re-register to hear the end.
            if (event.getAsyncContext() != null) event.getAsyncContext().addListener(this);
        }
    }

    /** The customer id, or why the resolver could not give one. */
    private record Resolved(String customerId, String failure) { }

    private Resolved resolveCustomerSafely(HttpServletRequest req) {
        try {
            return new Resolved(extractCustomerId(req), null);
        } catch (RuntimeException e) {
            return new Resolved(null, "customerIdResolver threw " + e.getClass().getName());
        }
    }

    /** Records one event; never throws. A resolver failure is counted as an INVALID drop. */
    private void meter(HttpServletRequest req, HttpServletResponse res, long startNanos, int status, Resolved customer) {
        long responseTimeMs = (System.nanoTime() - startNanos) / 1_000_000L;
        try {
            String path = req.getRequestURI();
            String metric;
            String failure = customer.failure();
            try {
                metric = resolveMetricName(req, res);
            } catch (RuntimeException e) {
                metric = null;
                if (failure == null) failure = "metricNameResolver threw " + e.getClass().getName();
            }
            if (failure != null) {
                // Counted and reported by the client as INVALID (no customer / no metric), never thrown.
                warnResolverFailure(failure);
                client.track(TrackEvent.builder(customer.customerId(), metric).quantity(1).build());
                return;
            }

            // A request with no customer is reported (INVALID) by the client, never blocked.
            client.track(TrackEvent.builder(customer.customerId(), metric)
                    .quantity(1)
                    .productType(productType)
                    .endpointPath(endpointPath(req, path))
                    .httpMethod(bounded("httpMethod", req.getMethod(), MAX_HTTP_METHOD_LENGTH))
                    .statusCode(status)
                    .responseTimeMs(responseTimeMs)
                    .metadata(Map.of("gateway", "java-servlet", "status", status))
                    .build());
        } catch (Exception e) {
            // Never let metering affect the API, but log for debugging
            LOG.log(java.util.logging.Level.FINE, "Metering capture failed", e);
        }
    }

    private final java.util.concurrent.atomic.AtomicLong resolverFailures = new java.util.concurrent.atomic.AtomicLong();

    private void warnResolverFailure(String failure) {
        long n = resolverFailures.incrementAndGet();
        if (n == 1 || n % 1000 == 0) {
            LOG.warning("[aforo] " + failure + "; the request was served and its event is dropped as INVALID ("
                    + n + " so far).");
        }
    }

    /**
     * An excluded path {@code p} matches the path itself or anything under {@code p + "/"},
     * compared on the path inside the application (the context path removed): {@code /health}
     * excludes {@code /health} and {@code /health/live}, not {@code /healthcare}.
     */
    private boolean isExcluded(HttpServletRequest req, String requestUri) {
        if (requestUri == null) return false;
        String path = requestUri;
        String contextPath = req.getContextPath();
        if (contextPath != null && !contextPath.isEmpty() && path.startsWith(contextPath)) {
            path = path.substring(contextPath.length());
            if (path.isEmpty()) path = "/";
        }
        for (String p : excludePaths) {
            if (p == null || p.isEmpty()) continue;
            String prefix = p.endsWith("/") ? p : p + "/";
            if (path.equals(prefix.substring(0, prefix.length() - 1)) || path.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }

    /** OPTIONS and excluded paths are never metered (and their customer is never resolved). */
    private boolean shouldMeter(HttpServletRequest req) {
        try {
            // CORS preflights are browser protocol, not billable calls, and carry
            // no credentials -- so they never have a customer.
            if ("OPTIONS".equalsIgnoreCase(req.getMethod())) return false;
            return !isExcluded(req, req.getRequestURI());
        } catch (RuntimeException e) {
            return true;
        }
    }

    private static boolean isRequestDispatch(HttpServletRequest req) {
        try {
            DispatcherType type = req.getDispatcherType();
            return type == null || type == DispatcherType.REQUEST;
        } catch (RuntimeException e) {
            return true;
        }
    }

    private static boolean isAsyncStarted(HttpServletRequest req) {
        try {
            return req.isAsyncStarted();
        } catch (RuntimeException e) {
            return false;
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
