%%%-------------------------------------------------------------------
%%% G368: broker events are pre-aggregated per (customer, metric[, topic])
%%% per window, with a stable idempotency key per aggregated event.
%%% G365: concurrent publishers never lose each other's counts.
%%%-------------------------------------------------------------------
-module(aforo_metering_aggregator_tests).

-include_lib("eunit/include/eunit.hrl").

-define(A, aforo_metering_aggregator).

run(Cfg, Fun) ->
    aforo_test_util:with_config(Cfg),
    ok = aforo_metering_cache:init(),
    ok = ?A:init(),
    try Fun()
    after
        ?A:delete(),
        aforo_metering_cache:delete(),
        aforo_test_util:reset_config()
    end.

%% Just past the end of every currently open 60 s window (+ 1 s grace).
far_future() -> erlang:system_time(millisecond) + 62000.

pub(C, Topic, Bytes) -> ?A:record({customer, C}, <<"PUBLISH">>, Topic, Bytes, #{clientid => <<"x">>}).

one_event_per_customer_metric_window_test() ->
    run(#{}, fun() ->
        aforo_test_util:await_window_room(),
        [pub(<<"cust_a">>, <<"s/1">>, 10) || _ <- lists:seq(1, 1000)],
        [pub(<<"cust_b">>, <<"s/2">>, 1) || _ <- lists:seq(1, 5)],
        {Events, 0} = ?A:close_windows(far_future()),
        ?assertEqual(2, length(Events)),
        [A] = [E || E = #{<<"customerId">> := <<"cust_a">>} <- Events],
        ?assertEqual(1000, maps:get(<<"quantity">>, A)),
        ?assertEqual(10000, maps:get(<<"dataBytes">>, A)),
        ?assertEqual(<<"mqtt_broker.publish">>, maps:get(<<"metricName">>, A)),
        ?assertEqual(<<"#">>, maps:get(<<"mqttTopic">>, A)),
        ?assertEqual(<<"MQTT_BROKER">>, maps:get(<<"productType">>, A)),
        ?assertEqual(1000, maps:get(<<"messageCount">>, maps:get(<<"metadata">>, A))),
        ?assertNot(maps:is_key(<<"mqttClientId">>, A))
    end).

metrics_are_separate_test() ->
    run(#{}, fun() ->
        pub(<<"c">>, <<"t">>, 0),
        ?A:record({customer, <<"c">>}, <<"SUBSCRIBE">>, <<"t">>, 0, #{}),
        {Events, 0} = ?A:close_windows(far_future()),
        ?assertEqual([<<"mqtt_broker.publish">>, <<"mqtt_broker.subscribe">>],
                     lists:sort([maps:get(<<"metricName">>, E) || E <- Events]))
    end).

by_topic_test() ->
    run(#{aggregate_by_topic => true}, fun() ->
        pub(<<"c">>, <<"a">>, 0), pub(<<"c">>, <<"a">>, 0), pub(<<"c">>, <<"b">>, 0),
        {Events, 0} = ?A:close_windows(far_future()),
        ?assertEqual([{<<"a">>, 2}, {<<"b">>, 1}],
                     lists:sort([{maps:get(<<"mqttTopic">>, E), maps:get(<<"quantity">>, E)} || E <- Events]))
    end).

long_topic_is_truncated_to_ingestor_limit_test() ->
    run(#{aggregate_by_topic => true}, fun() ->
        pub(<<"c">>, binary:copy(<<"é"/utf8>>, 400), 0),
        {[E], 0} = ?A:close_windows(far_future()),
        T = maps:get(<<"mqttTopic">>, E),
        ?assert(byte_size(T) =< 500),
        ?assert(is_binary(unicode:characters_to_binary(T)))
    end).

%% The window is not emitted before it has ended (plus grace).
open_window_is_not_emitted_test() ->
    run(#{}, fun() ->
        pub(<<"c">>, <<"t">>, 0),
        ?assertEqual({[], 0}, ?A:close_windows(erlang:system_time(millisecond))),
        ?assertEqual(1, ?A:open_keys())
    end).

idempotency_key_is_stable_and_well_formed_test() ->
    run(#{}, fun() ->
        pub(<<"c">>, <<"t">>, 0),
        {[E], 0} = ?A:close_windows(far_future()),
        K = maps:get(<<"idempotencyKey">>, E),
        ?assertMatch(<<"mqtt:", _:64/binary>>, K),
        ?assert(byte_size(K) =< 255),
        %% closing again emits nothing: the key travels with the event
        %% and every re-send reuses it
        ?assertEqual({[], 0}, ?A:close_windows(far_future()))
    end).

%% An increment that lands after its window was emitted is a second
%% event with its own key, not a duplicate the ingestor would discard.
late_increment_gets_a_new_key_test() ->
    run(#{}, fun() ->
        pub(<<"c">>, <<"t">>, 0),
        {[E1], 0} = ?A:close_windows(far_future()),
        pub(<<"c">>, <<"t">>, 0),
        %% force the late row into the same (already emitted) window
        [{Key, 1, 0}] = ets:tab2list(aforo_metering_agg),
        ets:delete(aforo_metering_agg, Key),
        {_, Owner, Type, Topic, Detail} = Key,
        Window = element(1, ets:first(aforo_metering_agg_emitted)),
        ets:insert(aforo_metering_agg, {{Window, Owner, Type, Topic, Detail}, 1, 0}),
        {[E2], 0} = ?A:close_windows(far_future()),
        ?assertEqual(maps:get(<<"occurredAt">>, E1), maps:get(<<"occurredAt">>, E2)),
        ?assertNotEqual(maps:get(<<"idempotencyKey">>, E1), maps:get(<<"idempotencyKey">>, E2))
    end).

%% Two plugin lives (or two broker nodes) never share keys.
keys_differ_across_incarnations_test() ->
    K = fun() ->
        run(#{}, fun() ->
            pub(<<"c">>, <<"t">>, 0),
            {[E], 0} = ?A:close_windows(far_future()),
            {maps:get(<<"idempotencyKey">>, E), maps:get(<<"occurredAt">>, E)}
        end)
    end,
    {K1, _} = K(),
    {K2, _} = K(),
    ?assertNotEqual(K1, K2).

no_aggregation_keeps_one_event_per_message_test() ->
    run(#{aggregation_window_seconds => 0}, fun() ->
        [?A:record({customer, <<"c">>}, <<"PUBLISH">>, <<"t">>, 3,
                   #{clientid => <<"dev">>, qos => 1, retain => true}) || _ <- lists:seq(1, 3)],
        {Events, 0} = ?A:close_windows(erlang:system_time(millisecond)),
        ?assertEqual(3, length(Events)),
        [E | _] = Events,
        ?assertEqual(1, maps:get(<<"quantity">>, E)),
        ?assertEqual(<<"dev">>, maps:get(<<"mqttClientId">>, E)),
        ?assertEqual(1, maps:get(<<"mqttQos">>, E)),
        ?assertEqual(true, maps:get(<<"mqttRetained">>, E)),
        ?assertEqual(<<"t">>, maps:get(<<"mqttTopic">>, E)),
        ?assertEqual(3, length(lists:usort([maps:get(<<"idempotencyKey">>, X) || X <- Events])))
    end).

key_cap_drops_new_keys_and_counts_test() ->
    run(#{max_aggregation_keys => 2}, fun() ->
        Before = aforo_test_util:counter('aforo.metering.aggregation.keys_dropped'),
        ok = pub(<<"c1">>, <<"t">>, 0),
        ok = pub(<<"c2">>, <<"t">>, 0),
        ?assertEqual(dropped, pub(<<"c3">>, <<"t">>, 0)),
        ok = pub(<<"c1">>, <<"t">>, 0),  %% an existing key keeps counting
        ?assertEqual(Before + 1, aforo_test_util:counter('aforo.metering.aggregation.keys_dropped'))
    end).

%% G365: 50 publishers at once; every message is counted.
concurrent_publishers_lose_nothing_test_() ->
    {timeout, 120, fun concurrent_publishers/0}.

concurrent_publishers() ->
    run(#{}, fun() ->
        aforo_test_util:await_window_room(20000),
        Parent = self(),
        Pids = [spawn(fun() ->
                    [pub(<<"c">>, <<"t">>, 1) || _ <- lists:seq(1, 2000)],
                    Parent ! {done, self()}
                end) || _ <- lists:seq(1, 50)],
        [receive {done, P} -> ok end || P <- Pids],
        {[E], 0} = ?A:close_windows(far_future()),
        ?assertEqual(100000, maps:get(<<"quantity">>, E)),
        ?assertEqual(100000, maps:get(<<"dataBytes">>, E))
    end).

%% Usage recorded while the customer lookup runs is attributed once the
%% answer arrives; a definitive "none" drops it (counted).
pending_rows_wait_for_resolution_test() ->
    run(#{}, fun() ->
        Ref = make_ref(),
        aforo_metering_cache:put_pending(<<"tenant_t">>, <<"dev">>, Ref, 60000, {undefined, <<>>}),
        ?A:record({client, <<"dev">>}, <<"PUBLISH">>, <<"t">>, 0, #{}),
        ?assertEqual({[], 0}, ?A:close_windows(erlang:system_time(millisecond) + 120000)),
        ok = aforo_metering_cache:complete_pending(<<"tenant_t">>, <<"dev">>, Ref, <<"cust_late">>),
        {[E], 0} = ?A:close_windows(erlang:system_time(millisecond) + 120000),
        ?assertEqual(<<"cust_late">>, maps:get(<<"customerId">>, E))
    end).

unresolvable_rows_are_dropped_and_counted_test() ->
    run(#{}, fun() ->
        aforo_metering_cache:put_negative(<<"tenant_t">>, <<"dev">>, 60000),
        ?A:record({client, <<"dev">>}, <<"PUBLISH">>, <<"t">>, 0, #{}),
        ?A:record({client, <<"dev">>}, <<"PUBLISH">>, <<"t">>, 0, #{}),
        ?assertEqual({[], 2}, ?A:close_windows(far_future()))
    end).

close_all_emits_open_windows_test() ->
    run(#{}, fun() ->
        pub(<<"c">>, <<"t">>, 0),
        {[E], 0} = ?A:close_all(),
        ?assertEqual(1, maps:get(<<"quantity">>, E)),
        ?assertEqual(0, ?A:open_keys())
    end).
