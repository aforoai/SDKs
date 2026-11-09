package com.aforo.metering.spring;

import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Configuration;

/**
 * Started in a child JVM without the servlet API on the classpath (a WebFlux or worker app)
 * by {@link ReviewRegressionServletTest}. Prints STARTED when the context comes up.
 */
@Configuration(proxyBeanMethods = false)
@ImportAutoConfiguration(AforoMeteringAutoConfiguration.class)
public class NonServletStartupMain {
    public static void main(String[] args) {
        try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(NonServletStartupMain.class)
                .web(WebApplicationType.NONE).logStartupInfo(false).bannerMode(org.springframework.boot.Banner.Mode.OFF)
                .properties("aforo.enabled=true", "aforo.api-key=k", "aforo.base-url=http://localhost:1",
                        "aforo.shutdown-timeout-ms=0")
                .run()) {
            ctx.getBean(com.aforo.metering.AforoClient.class);
            System.out.println("STARTED");
        } catch (Throwable t) {
            Throwable root = t;
            while (root.getCause() != null) root = root.getCause();
            System.out.println("FAILED " + root);
        }
    }
}
