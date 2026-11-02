package com.aforo.metering.spring;

import com.aforo.metering.AforoClient;
import com.aforo.metering.AforoOptions;
import com.aforo.metering.DropReason;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Proxy;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@DisplayName("AforoServletFilter — customer identity (G265 / G310)")
class AforoServletFilterIdentityTest {

    private final List<DropReason> reasons = new CopyOnWriteArrayList<>();
    private final AforoClient client = new AforoClient(new AforoOptions("k")
            .baseUrl("http://127.0.0.1:1").flushIntervalMs(60_000).shutdownTimeoutMs(0)
            .onDrop((events, reason) -> reasons.add(reason)));

    @AfterEach
    void close() {
        client.close();
    }

    private static HttpServletRequest request(String customerHeader) {
        return (HttpServletRequest) Proxy.newProxyInstance(
                AforoServletFilterIdentityTest.class.getClassLoader(), new Class<?>[]{HttpServletRequest.class},
                (proxy, m, args) -> switch (m.getName()) {
                    case "getRequestURI" -> "/v1/things";
                    case "getMethod" -> "GET";
                    case "getHeader" -> "X-Customer-Id".equals(args[0]) ? customerHeader : null;
                    default -> null;
                });
    }

    private static HttpServletResponse response() {
        return (HttpServletResponse) Proxy.newProxyInstance(
                AforoServletFilterIdentityTest.class.getClassLoader(), new Class<?>[]{HttpServletResponse.class},
                (proxy, m, args) -> "getStatus".equals(m.getName()) ? 200 : null);
    }

    @Test
    void buildFailsWithoutACustomerSource() {
        assertThatThrownBy(() -> AforoServletFilter.builder(client).build())
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("customerIdResolver")
                .hasMessageContaining("trustCustomerHeader(true)");
    }

    @Test
    void theHeaderIsIgnoredWhenOnlyAResolverIsConfigured() throws Exception {
        AforoServletFilter filter = AforoServletFilter.builder(client).customerIdResolver(req -> "cust_auth").build();
        filter.doFilter(request("cust_spoofed"), response(), (q, s) -> { });
        assertThat(client.bufferedCount()).isEqualTo(1);
        assertThat(reasons).isEmpty();
    }

    @Test
    void aRequestWithNoCustomerIsCountedAsInvalidAndStillServed() throws Exception {
        AtomicInteger served = new AtomicInteger();
        AforoServletFilter filter = AforoServletFilter.builder(client).customerIdResolver(req -> null).build();
        filter.doFilter(request("cust_spoofed"), response(), (q, s) -> served.incrementAndGet());
        assertThat(served.get()).isEqualTo(1);
        assertThat(client.bufferedCount()).isZero();
        assertThat(reasons).containsExactly(DropReason.INVALID);
        assertThat(client.droppedCount()).isEqualTo(1);
    }

    @Test
    void destroyLeavesASharedClientOpenWhenAsked() {
        AforoServletFilter.builder(client).trustCustomerHeader(true).closeClientOnDestroy(false).build().destroy();
        assertThat(client.isClosed()).isFalse();
        AforoServletFilter.builder(client).trustCustomerHeader(true).build().destroy();
        assertThat(client.isClosed()).isTrue();
    }
}
