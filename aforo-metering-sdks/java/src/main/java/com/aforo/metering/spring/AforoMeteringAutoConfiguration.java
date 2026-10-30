package com.aforo.metering.spring;

import com.aforo.metering.AforoClient;
import com.aforo.metering.AforoOptions;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Spring Boot auto-configuration for Aforo metering.
 *
 * <p>Enabled when {@code aforo.enabled=true}. Requires {@code aforo.api-key}. Every
 * bean backs off when you declare your own ({@code @ConditionalOnMissingBean}).</p>
 *
 * <p>The servlet filter needs to know the customer for each request. Declare an
 * {@link AforoServletFilter.CustomerIdResolver} bean that reads it from your
 * authentication, set {@code aforo.use-principal-as-customer-id=true}, or set
 * {@code aforo.trust-customer-header=true} to read {@code X-Customer-Id} (only when
 * a gateway in front of the app sets that header). With none of them, startup fails.</p>
 *
 * <pre>
 * # application.yml
 * aforo:
 *   enabled: true
 *   api-key: ${AFORO_API_KEY}
 *   base-url: https://api.aforo.ai
 *   product-type: API                 # default; e.g. AGENTIC_API
 *   metric-name: api_calls            # must exist in your Aforo catalog
 *   shutdown-timeout-ms: 5000         # how long Spring's stop phase keeps sending
 * </pre>
 *
 * <p>The client is closed in Spring's stop phase ({@link AforoClientLifecycle}), not
 * by a JVM shutdown hook, so queued usage is sent before the context goes away.</p>
 */
@AutoConfiguration
@EnableConfigurationProperties
@ConditionalOnProperty(name = "aforo.enabled", havingValue = "true")
public class AforoMeteringAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean
    @ConfigurationProperties(prefix = "aforo")
    public AforoMeteringProperties aforoMeteringProperties() {
        return new AforoMeteringProperties();
    }

    @Bean
    @ConditionalOnMissingBean
    public AforoClient aforoClient(AforoMeteringProperties props) {
        AforoOptions options = new AforoOptions(props.getApiKey())
                // Spring's stop phase closes the client (AforoClientLifecycle); a JVM hook would race it.
                .registerShutdownHook(false);
        if (props.getBaseUrl() != null) options.baseUrl(props.getBaseUrl());
        if (props.getProductType() != null) options.productType(props.getProductType());
        if (props.getFlushCount() > 0) options.flushCount(props.getFlushCount());
        if (props.getFlushIntervalMs() > 0) options.flushIntervalMs(props.getFlushIntervalMs());
        if (props.getMaxQueueSize() > 0) options.maxQueueSize(props.getMaxQueueSize());
        if (props.getTimeoutMs() > 0) options.timeoutMs(props.getTimeoutMs());
        if (props.getShutdownTimeoutMs() >= 0) options.shutdownTimeoutMs(props.getShutdownTimeoutMs());
        options.allowInsecureHttp(props.isAllowInsecureHttp());
        options.compression(props.getCompression());
        return new AforoClient(options);
    }

    @Bean
    @ConditionalOnMissingBean
    public AforoClientLifecycle aforoClientLifecycle(AforoClient client) {
        return new AforoClientLifecycle(client);
    }

    /** Servlet filter, registered only in a servlet web application. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
    @ConditionalOnClass(name = "jakarta.servlet.Filter")
    static class ServletFilterConfiguration {

        @Bean
        @ConditionalOnMissingBean(name = "aforoMeteringFilter")
        public FilterRegistrationBean<AforoServletFilter> aforoMeteringFilter(
                AforoClient client,
                AforoMeteringProperties props,
                ObjectProvider<AforoServletFilter.MetricNameResolver> metricNameResolver,
                ObjectProvider<AforoServletFilter.CustomerIdResolver> customerIdResolver) {
            return AforoMeteringAutoConfiguration.filterRegistration(client, props,
                    metricNameResolver.getIfAvailable(), customerIdResolver.getIfAvailable());
        }
    }

    /**
     * Builds the filter registration; throws {@link IllegalStateException} when there is no
     * customer source (no resolver bean, {@code use-principal-as-customer-id} and
     * {@code trust-customer-header} both off).
     */
    static FilterRegistrationBean<AforoServletFilter> filterRegistration(
            AforoClient client, AforoMeteringProperties props,
            AforoServletFilter.MetricNameResolver metricNameResolver,
            AforoServletFilter.CustomerIdResolver customerIdResolver) {
        if (customerIdResolver == null && !props.isUsePrincipalAsCustomerId() && !props.isTrustCustomerHeader()) {
            throw new IllegalStateException("aforo.enabled=true but the servlet filter has no way to know the"
                    + " customer of a request. Declare an AforoServletFilter.CustomerIdResolver bean that reads it"
                    + " from your authentication, set aforo.use-principal-as-customer-id=true when the principal"
                    + " name is the Aforo customer id, or set aforo.trust-customer-header=true to read "
                    + props.getCustomerIdHeader() + " (only when a gateway in front of the app sets it).");
        }
        AforoServletFilter.Builder builder = AforoServletFilter.builder(client)
                .metricName(props.getMetricName())
                .customerIdHeader(props.getCustomerIdHeader())
                .trustCustomerHeader(props.isTrustCustomerHeader())
                .usePrincipalAsCustomerId(props.isUsePrincipalAsCustomerId())
                // The client is a Spring bean; AforoClientLifecycle closes it.
                .closeClientOnDestroy(false);
        if (metricNameResolver != null) builder.metricNameResolver(metricNameResolver);
        if (customerIdResolver != null) builder.customerIdResolver(customerIdResolver);

        FilterRegistrationBean<AforoServletFilter> registration = new FilterRegistrationBean<>();
        registration.setFilter(builder.build());
        registration.addUrlPatterns("/*");
        registration.setOrder(Integer.MAX_VALUE); // Run last
        registration.setName("aforoMeteringFilter");
        return registration;
    }
}
