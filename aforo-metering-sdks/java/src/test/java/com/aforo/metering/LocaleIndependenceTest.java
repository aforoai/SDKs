package com.aforo.metering;

import com.aforo.metering.internal.transport.TransportCore;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Locale;

import static org.assertj.core.api.Assertions.assertThat;

/** G311: wire values must not change under a Turkish default locale (dotless i). */
@DisplayName("Locale independence (tr_TR)")
class LocaleIndependenceTest {

    private Locale saved;

    @BeforeEach
    void turkish() {
        saved = Locale.getDefault();
        Locale.setDefault(Locale.forLanguageTag("tr-TR"));
    }

    @AfterEach
    void restore() {
        Locale.setDefault(saved);
    }

    @Test
    void wireValuesAreLocaleIndependent() {
        assertThat("invalid".toUpperCase()).isNotEqualTo("INVALID"); // the trap this test guards against
        assertThat(new AforoOptions("k").productType("agentic_api").getProductType()).isEqualTo("AGENTIC_API");
        assertThat(TrackEvent.builder("c", "m").executionStatus("hitl_required").build().getExecutionStatus())
                .isEqualTo("HITL_REQUIRED");
        assertThat(TrackEvent.builder("c", "m").productType("ai_agent").build().getProductType()).isEqualTo("AI_AGENT");
        for (TransportCore.Reason r : TransportCore.Reason.values()) {
            assertThat(r.wireName()).isEqualTo(r.name().toLowerCase(Locale.ROOT)).doesNotContain("ı");
        }
    }
}
