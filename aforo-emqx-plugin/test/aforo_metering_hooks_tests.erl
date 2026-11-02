%%%-------------------------------------------------------------------
%%% The broker hook callbacks end to end (without an EMQX node): connect
%%% resolves from client_attrs, later PUBLISHes are attributed through the
%%% cache, nothing is sent from the client's process.
%%%-------------------------------------------------------------------
-module(aforo_metering_hooks_tests).

-include_lib("eunit/include/eunit.hrl").
-include("aforo_metering_emqx.hrl").

-define(M, aforo_metering).
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

ci(Id, Attrs) -> #{clientid => Id, username => <<"chosen-by-client">>, client_attrs => Attrs}.

msg(From, Topic, Payload) ->
    #message{id = <<"1">>, qos = 1, from = From, flags = #{retain => false},
             topic = Topic, payload = Payload, timestamp = 0}.

far_future() -> erlang:system_time(millisecond) + 62000.

connected_client_publishes_are_billed_to_authn_customer_test() ->
    run(#{}, fun() ->
        aforo_test_util:await_window_room(),
        ok = ?M:on_client_connected(ci(<<"dev">>, #{<<"aforo_customer_id">> => <<"cust_ok">>}), #{}, []),
        M = msg(<<"dev">>, <<"s/t">>, <<"12345">>),
        [{ok, M} = ?M:on_message_publish(M, []) || _ <- lists:seq(1, 10)],
        {Evs, 0} = ?A:close_windows(far_future()),
        [Pub] = [E || E = #{<<"metricName">> := <<"mqtt_broker.publish">>} <- Evs],
        ?assertEqual(<<"cust_ok">>, maps:get(<<"customerId">>, Pub)),
        ?assertEqual(10, maps:get(<<"quantity">>, Pub)),
        ?assertEqual(50, maps:get(<<"dataBytes">>, Pub)),
        [Conn] = [E || E = #{<<"metricName">> := <<"mqtt_broker.connect">>} <- Evs],
        ?assertEqual(1, maps:get(<<"quantity">>, Conn))
    end).

%% No authenticated customer: nothing is billed (and the client-chosen
%% username is not used), the loss is counted.
unauthenticated_client_is_not_billed_test() ->
    run(#{}, fun() ->
        Before = aforo_test_util:counter('aforo.metering.events.unresolved'),
        ok = ?M:on_client_connected(ci(<<"dev2">>, #{}), #{}, []),
        M = msg(<<"dev2">>, <<"s/t">>, <<"x">>),
        {ok, M} = ?M:on_message_publish(M, []),
        ?assertEqual({[], 0}, ?A:close_windows(far_future())),
        ?assertEqual(Before + 2, aforo_test_util:counter('aforo.metering.events.unresolved'))
    end).

system_topics_are_skipped_test() ->
    run(#{}, fun() ->
        ok = ?M:on_client_connected(ci(<<"d">>, #{<<"aforo_customer_id">> => <<"c">>}), #{}, []),
        M = msg(<<"d">>, <<"$SYS/brokers">>, <<"x">>),
        {ok, M} = ?M:on_message_publish(M, []),
        {Evs, 0} = ?A:close_windows(far_future()),
        ?assertEqual([], [E || E = #{<<"metricName">> := <<"mqtt_broker.publish">>} <- Evs])
    end).

subscribe_and_disconnect_test() ->
    run(#{}, fun() ->
        aforo_test_util:await_window_room(),
        C = ci(<<"d">>, #{<<"aforo_customer_id">> => <<"c">>}),
        ok = ?M:on_client_connected(C, #{}, []),
        ok = ?M:on_session_subscribed(C, <<"a/#">>, #{qos => 1}, []),
        ok = ?M:on_client_disconnected(C, normal, #{}, []),
        {Evs, 0} = ?A:close_windows(far_future()),
        ?assertEqual([<<"mqtt_broker.connect">>, <<"mqtt_broker.disconnect">>, <<"mqtt_broker.subscribe">>],
                     lists:sort([maps:get(<<"metricName">>, E) || E <- Evs])),
        %% the customer survives the disconnect long enough to close windows
        ?assertEqual(<<"c">>, aforo_metering_customer_resolver:lookup(<<"d">>))
    end).

%% A failing hook never breaks message delivery.
hook_failure_is_contained_test() ->
    aforo_test_util:with_config(#{}),
    try
        %% no tables: every recording path fails inside the hook
        M = msg(<<"d">>, <<"t">>, <<"x">>),
        ?assertEqual({ok, M}, ?M:on_message_publish(M, [])),
        ?assertEqual(ok, ?M:on_client_connected(ci(<<"d">>, #{<<"aforo_customer_id">> => <<"c">>}), #{}, []))
    after
        aforo_test_util:reset_config()
    end.
