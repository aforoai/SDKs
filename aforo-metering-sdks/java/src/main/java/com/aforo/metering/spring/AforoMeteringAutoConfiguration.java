package com.aforo.metering.spring;

import com.aforo.metering.AforoClient;
import com.aforo.metering.AforoOptions;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Spring Boot auto-configuration for Aforo metering.
 *
 * <p>Enabled when {@code aforo.enabled=true} in application properties.
 * Requires {@code aforo.api-key} to be set.</p>
 *
 * <pre>
 * # application.yml
 * aforo:
 *   enabled: true
 *   api-key: ${AFORO_API_KEY}
 *   base-url: https://ingest.aforo.ai
 * </pre>
 */
@Configuration
@ConditionalOnProperty(name = "aforo.enabled", havingValue = "true")
public class AforoMeteringAutoConfiguration {

    @Bean
    @ConfigurationProperties(prefix = "aforo")
    public AforoMeteringProperties aforoMeteringProperties() {
        return new AforoMeteringProperties();
    }

    @Bean
    public AforoClient aforoClient(AforoMeteringProperties props) {
        AforoOptions options = new AforoOptions(props.getApiKey());
        if (props.getBaseUrl() != null) options.baseUrl(props.getBaseUrl());
        if (props.getFlushCount() > 0) options.flushCount(props.getFlushCount());
        if (props.getFlushIntervalMs() > 0) options.flushIntervalMs(props.getFlushIntervalMs());
        return new AforoClient(options);
    }

    @Bean
    public FilterRegistrationBean<AforoServletFilter> aforoMeteringFilter(AforoClient client) {
        FilterRegistrationBean<AforoServletFilter> registration = new FilterRegistrationBean<>();
        registration.setFilter(new AforoServletFilter(client));
        registration.addUrlPatterns("/*");
        registration.setOrder(Integer.MAX_VALUE); // Run last
        registration.setName("aforoMeteringFilter");
        return registration;
    }
}
