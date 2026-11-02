package com.aforo.metering.spring;

import com.aforo.metering.AforoClient;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.boot.web.context.WebServerGracefulShutdownLifecycle;

import java.lang.reflect.Constructor;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Spring stops lifecycles from the highest phase down, and beans in the same phase in no
 * defined order. The client must stop strictly after the embedded web server, so the usage
 * of the server's last requests is queued before the client drains it. The phases are read
 * from the Spring Boot classes on the classpath, not copied.
 */
@DisplayName("AforoClientLifecycle — stops strictly after the web server")
class AforoClientLifecyclePhaseTest {

    @Test
    void stopsAfterTheWebServerAndItsGracefulShutdown() throws Exception {
        int ours = new AforoClientLifecycle((AforoClient) null).getPhase();

        Class<?> startStop = Class.forName("org.springframework.boot.web.servlet.context.WebServerStartStopLifecycle");
        Constructor<?> ctor = startStop.getDeclaredConstructors()[0];
        ctor.setAccessible(true);
        Object lifecycle = ctor.newInstance(new Object[ctor.getParameterCount()]);
        var getPhase = startStop.getDeclaredMethod("getPhase");
        getPhase.setAccessible(true);
        int webServer = (int) getPhase.invoke(lifecycle);

        assertThat(ours).isLessThan(webServer);
        assertThat(ours).isLessThan(WebServerGracefulShutdownLifecycle.SMART_LIFECYCLE_PHASE);
    }
}
