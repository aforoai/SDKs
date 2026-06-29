package com.aforo.metering;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@DisplayName("RingBuffer — thread-safe bounded buffer")
class RingBufferTest {

    private ResolvedEvent event(int n) {
        return new ResolvedEvent("cust_" + n, "api_calls", 1, "key_" + n, "2026-03-21T00:00:00Z", null);
    }

    @Test
    void pushAndDrain() {
        var buf = new RingBuffer(10);
        buf.push(event(1));
        buf.push(event(2));
        buf.push(event(3));

        assertThat(buf.size()).isEqualTo(3);
        assertThat(buf.isEmpty()).isFalse();

        List<ResolvedEvent> items = buf.drain();
        assertThat(items).hasSize(3);
        assertThat(items.get(0).getCustomerId()).isEqualTo("cust_1");
        assertThat(buf.isEmpty()).isTrue();
    }

    @Test
    void overflowDropsOldest() {
        var buf = new RingBuffer(3);
        assertThat(buf.push(event(1))).isTrue();
        assertThat(buf.push(event(2))).isTrue();
        assertThat(buf.push(event(3))).isTrue();
        assertThat(buf.push(event(4))).isFalse(); // overflow

        assertThat(buf.size()).isEqualTo(3);
        List<ResolvedEvent> items = buf.drain();
        assertThat(items.get(0).getCustomerId()).isEqualTo("cust_2");
        assertThat(items.get(2).getCustomerId()).isEqualTo("cust_4");
    }

    @Test
    void drainUpTo() {
        var buf = new RingBuffer(100);
        for (int i = 0; i < 10; i++) buf.push(event(i));

        var batch = buf.drainUpTo(3);
        assertThat(batch).hasSize(3);
        assertThat(buf.size()).isEqualTo(7);
    }

    @Test
    void drainEmpty() {
        var buf = new RingBuffer(10);
        assertThat(buf.drain()).isEmpty();
        assertThat(buf.drainUpTo(5)).isEmpty();
    }

    @Test
    void invalidCapacity() {
        assertThatThrownBy(() -> new RingBuffer(0))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
