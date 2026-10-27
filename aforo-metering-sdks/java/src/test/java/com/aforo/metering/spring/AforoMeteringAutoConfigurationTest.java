package com.aforo.metering.spring;

import com.aforo.metering.AforoClient;
import com.aforo.metering.AforoOptions;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("AforoMeteringAutoConfiguration — G307 / G310")
class AforoMeteringAutoConfigurationTest {

    private final WebApplicationContextRunner runner = new WebApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(AforoMeteringAutoConfiguration.class))
            .withPropertyValues("aforo.enabled=true", "aforo.api-key=sk_test_key",
                    "aforo.base-url=http://127.0.0.1:1", "aforo.shutdown-timeout-ms=0");

    @Test
    void failsAtStartupWithoutACustomerSource() {
        runner.run(ctx -> {
            assertThat(ctx).hasFailed();
            assertThat(ctx.getStartupFailure()).rootCause()
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("CustomerIdResolver")
                    .hasMessageContaining("aforo.trust-customer-header=true");
        });
    }

    @Test
    void startsWithAResolverBean() {
        runner.withUserConfiguration(ResolverConfig.class).run(ctx -> {
            assertThat(ctx).hasNotFailed();
            assertThat(ctx).hasSingleBean(AforoClient.class);
            assertThat(ctx).hasSingleBean(AforoClientLifecycle.class);
            assertThat(ctx).hasBean("aforoMeteringFilter");
        });
    }

    @Test
    void startsWithTheExplicitHeaderOptIn() {
        runner.withPropertyValues("aforo.trust-customer-header=true").run(ctx -> assertThat(ctx).hasNotFailed());
    }

    @Test
    void backsOffWhenTheAppDeclaresItsOwnBeans() {
        runner.withUserConfiguration(ResolverConfig.class, OwnClientConfig.class).run(ctx -> {
            assertThat(ctx).hasNotFailed();
            assertThat(ctx).hasSingleBean(AforoClient.class);
            assertThat(ctx.getBean(AforoClient.class)).isSameAs(ctx.getBean("myClient"));
            assertThat(ctx.getBean("aforoMeteringFilter")).isSameAs(OwnClientConfig.FILTER);
        });
    }

    @Test
    void springStopPhaseClosesTheClient() {
        AforoClient[] seen = new AforoClient[1];
        runner.withPropertyValues("aforo.trust-customer-header=true").run(ctx -> {
            seen[0] = ctx.getBean(AforoClient.class);
            assertThat(seen[0].isClosed()).isFalse();
        });
        assertThat(seen[0].isClosed()).isTrue();
    }

    @Test
    void noBeansWhenDisabled() {
        new WebApplicationContextRunner()
                .withConfiguration(AutoConfigurations.of(AforoMeteringAutoConfiguration.class))
                .run(ctx -> assertThat(ctx).doesNotHaveBean(AforoClient.class));
    }

    @Configuration(proxyBeanMethods = false)
    static class ResolverConfig {
        @Bean
        AforoServletFilter.CustomerIdResolver customerIdResolver() {
            return req -> req.getUserPrincipal() == null ? null : req.getUserPrincipal().getName();
        }
    }

    @Configuration(proxyBeanMethods = false)
    static class OwnClientConfig {
        static final FilterRegistrationBean<AforoServletFilter> FILTER = new FilterRegistrationBean<>();

        @Bean
        AforoClient myClient() {
            return new AforoClient(new AforoOptions("own").baseUrl("http://127.0.0.1:1").shutdownTimeoutMs(0));
        }

        @Bean
        FilterRegistrationBean<AforoServletFilter> aforoMeteringFilter() {
            return FILTER;
        }
    }
}
