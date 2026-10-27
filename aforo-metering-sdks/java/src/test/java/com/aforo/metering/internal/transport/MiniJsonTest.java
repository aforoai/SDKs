package com.aforo.metering.internal.transport;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@DisplayName("MiniJson — ingestor response reader")
class MiniJsonTest {

    @Test
    void readsTheBatchResponseEnvelope() {
        Object root = MiniJson.parse("{\"success\":true,\"data\":{\"accepted\":2,\"failed\":1,"
                + "\"errors\":[{\"index\":0,\"message\":\"bad \\\"x\\\" \\u00e9\",\"retryable\":false}]},\"meta\":null}");
        Map<?, ?> data = (Map<?, ?>) ((Map<?, ?>) root).get("data");
        assertThat(data.get("accepted")).isEqualTo(2.0);
        Map<?, ?> err = (Map<?, ?>) ((List<?>) data.get("errors")).get(0);
        assertThat(err.get("message")).isEqualTo("bad \"x\" é");
        assertThat(err.get("retryable")).isEqualTo(false);
    }

    @Test
    void rejectsMalformedInput() {
        assertThatThrownBy(() -> MiniJson.parse("{\"a\":")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> MiniJson.parse("<html>")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> MiniJson.parse("[1] x")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void readsScalarsAndNesting() {
        assertThat(MiniJson.parse(" [1.5e2, -3, null, \"\"] ")).isEqualTo(java.util.Arrays.asList(150.0, -3.0, null, ""));
        assertThat(MiniJson.parse("{}")).isEqualTo(Map.of());
    }
}
