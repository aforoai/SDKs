%%%-------------------------------------------------------------------
%%% Regression tests for the independent review of 2.0.0 (2026-10-27):
%%% table ownership across worker crashes, http lookups retried for
%%% publish-only clients, pending TTL, session takeover, queue room at
%%% window close, exclude_topics, QoS/retain dimensions, close racing
%%% increments, loss accounting when the flusher stops.
%%%-------------------------------------------------------------------
-module(aforo_metering_review_tests).

-include_lib("eunit/include/eunit.hrl").

-define(R, aforo_metering_customer_resolver).
-define(A, aforo_metering_aggregator).
-define(C, aforo_metering_cache).
-define(T, <<"tenant_t">>).

wait_until(Fun, Ms) when Ms =< 0 -> Fun();
wait_until(Fun, Ms) ->
    case Fun() of true -> true; _ -> timer:sleep(20), wait_until(Fun, Ms - 20) end.

far_future() -> erlang:system_time(millisecond) + 62000.

tables(Cfg, Fun) ->
    aforo_test_util:with_config(Cfg),
    ok = ?C:init(),
    ok = ?A:init(),
    try Fun()
    after
        ?A:delete(), ?C:delete(), aforo_test_util:reset_config()
    end.

pub(C, Topic, Info) -> ?A:record({customer, C}, <<"PUBLISH">>, Topic, 1, Info).

%% ── #2 / #6: the supervisor owns the tables ─────────────────────────

worker_crash_keeps_cache_and_windows_test_() ->
    {timeout, 30, fun() ->
        aforo_test_util:with_config(#{}),
        process_flag(trap_exit, true),
        {ok, Sup} = aforo_metering_sup:start_link(),
        try
            ok = ?C:put(?T, <<"dev">>, <<"cust">>),
            ok = pub(<<"cust">>, <<"t">>, #{}),
            Pool = whereis(aforo_metering_resolver_pool),
            Flusher = whereis(aforo_metering_flusher),
            exit(Pool, kill),
            exit(Flusher, kill),
            ?assert(wait_until(fun() ->
                is_pid(whereis(aforo_metering_resolver_pool)) andalso
                whereis(aforo_metering_resolver_pool) =/= Pool andalso
                is_pid(whereis(aforo_metering_flusher)) andalso
                whereis(aforo_metering_flusher) =/= Flusher end, 5000)),
            ?assertEqual({ok, <<"cust">>}, ?C:get(?T, <<"dev">>)),
            ?assertEqual(1, ?A:open_keys())
        after
            unlink(Sup), exit(Sup, shutdown),
            Ref = monitor(process, Sup),
            receive {'DOWN', Ref, _, _, _} -> ok after 5000 -> ok end,
            ?A:delete(),
            aforo_test_util:reset_config()
        end
    end}.

%% ── #3: a publish-only client is retried after a failed lookup ─────

publish_only_client_is_retried_test_() ->
    {timeout, 30, fun() ->
        Calls = counters:new(1, []),
        Srv = {_, Port, _} = aforo_test_util:start_http_server(fun(_) ->
            counters:add(Calls, 1, 1),
            case counters:get(Calls, 1) of
                1 -> {0, 503, <<>>};
                _ -> {0, 200, <<"{\"customerId\":\"cust_late\"}">>}
            end
        end),
        Url = list_to_binary("http://127.0.0.1:" ++ integer_to_list(Port) ++ "/r"),
        aforo_test_util:with_config(#{customer_resolver => <<"http">>,
                                      customer_resolver_http_url => Url,
                                      customer_resolver_negative_ttl_seconds => 1}),
        ok = aforo_metering_http:start_profile(),
        ok = ?C:init(),
        {ok, Pool} = aforo_metering_resolver_pool:start_link(),
        unlink(Pool),
        try
            pending = ?R:resolve_connect(#{clientid => <<"pub-only">>, username => <<"u">>},
                                         #{connected_at => 1}),
            ?assert(wait_until(fun() -> ?R:lookup(<<"pub-only">>) =:= undefined end, 3000)),
            timer:sleep(1100),
            %% the negative TTL passed: the next publish retries with the
            %% username stored at connect
            _ = ?R:lookup(<<"pub-only">>),
            ?assert(wait_until(fun() -> ?R:lookup(<<"pub-only">>) =:= <<"cust_late">> end, 3000))
        after
            exit(Pool, kill), ?C:delete(),
            aforo_test_util:stop_http_server(Srv), aforo_test_util:reset_config()
        end
    end}.

%% ── #4: pending lasts as long as usage is held for it ──────────────

pending_ttl_is_pending_max_test() ->
    tables(#{customer_resolver_pending_max_seconds => 300}, fun() ->
        ok = ?C:put_pending(?T, <<"d">>, make_ref(),
                            aforo_metering_config:pending_max_ms(), {undefined, <<>>}),
        [{_, pending, _, Exp, _, _}] = ets:lookup(aforo_metering_customer_cache, {?T, <<"d">>}),
        ?assert(Exp - ?C:now_ms() > 290000)
    end).

%% A refused lookup keeps the client's previous customer.
refused_lookup_keeps_previous_customer_test() ->
    tables(#{}, fun() ->
        ok = ?C:put(?T, <<"d">>, <<"cust_prev">>),
        Ref = make_ref(),
        ok = ?C:put_pending(?T, <<"d">>, Ref, 60000, {2, <<"u">>}),
        ?assertEqual({ok, <<"cust_prev">>}, ?C:get(?T, <<"d">>)),
        ok = ?C:refuse_pending(?T, <<"d">>, Ref),
        ?assertEqual({ok, <<"cust_prev">>}, ?C:get(?T, <<"d">>))
    end).

%% A lookup answered after the client left does not live forever.
late_answer_after_disconnect_expires_test() ->
    tables(#{}, fun() ->
        Ref = make_ref(),
        ok = ?C:put_pending(?T, <<"d">>, Ref, 60000, {1, <<"u">>}),
        ok = ?C:expire_after(?T, <<"d">>, 1, 0),
        ok = ?C:complete_pending(?T, <<"d">>, Ref, <<"c">>),
        [{_, ok, <<"c">>, Exp, gone, _}] = ets:lookup(aforo_metering_customer_cache, {?T, <<"d">>}),
        ?assert(is_integer(Exp)),
        timer:sleep(5),
        ?C:sweep(),
        ?assertEqual([], ets:lookup(aforo_metering_customer_cache, {?T, <<"d">>}))
    end).

%% ── #7: session takeover ───────────────────────────────────────────

old_session_disconnect_does_not_expire_new_session_test() ->
    tables(#{}, fun() ->
        CI = #{clientid => <<"d">>, client_attrs => #{<<"aforo_customer_id">> => <<"c">>}},
        <<"c">> = ?R:resolve_connect(CI, #{connected_at => 1}),
        <<"c">> = ?R:resolve_connect(CI, #{connected_at => 2}),
        ok = ?R:on_disconnect(CI, #{connected_at => 1}),
        [{_, ok, <<"c">>, infinity, 2, _}] =
            ets:lookup(aforo_metering_customer_cache, {?T, <<"d">>}),
        ok = ?R:on_disconnect(CI, #{connected_at => 2}),
        [{_, ok, <<"c">>, Exp, gone, _}] = ets:lookup(aforo_metering_customer_cache, {?T, <<"d">>}),
        ?assert(is_integer(Exp))
    end).

%% ── #5: closing windows respects the queue's room ──────────────────

close_windows_respects_room_test() ->
    tables(#{}, fun() ->
        [pub(<<"c", (integer_to_binary(N))/binary>>, <<"t">>, #{}) || N <- lists:seq(1, 100)],
        {Evs, 0} = ?A:close_windows(far_future(), 30),
        ?assertEqual(30, length(Evs)),
        ?assertEqual(70, ?A:open_keys()),
        {Rest, 0} = ?A:close_windows(far_future(), infinity),
        ?assertEqual(70, length(Rest))
    end).

%% ── #1: QoS and retain stay dimensions ─────────────────────────────

qos_and_retain_are_dimensions_test() ->
    tables(#{}, fun() ->
        pub(<<"c">>, <<"t">>, #{qos => 1, retain => true}),
        pub(<<"c">>, <<"t">>, #{qos => 1, retain => true}),
        pub(<<"c">>, <<"t">>, #{qos => 0, retain => false}),
        {Evs, 0} = ?A:close_windows(far_future()),
        ?assertEqual([{0, false, 1}, {1, true, 2}],
                     lists:sort([{maps:get(<<"mqttQos">>, E), maps:get(<<"mqttRetained">>, E),
                                  maps:get(<<"quantity">>, E)} || E <- Evs]))
    end).

%% ── exclude_topics is read ─────────────────────────────────────────

exclude_topics_test() ->
    tables(#{exclude_topics => [<<"devices/+/heartbeat">>, <<"#">>]}, fun() ->
        ?assert(?A:excluded(<<"devices/x/heartbeat">>)),
        ?assert(?A:excluded(<<"anything/else">>)),
        ?assert(?A:excluded(<<"$SYS/brokers">>))
    end),
    tables(#{exclude_topics => [<<"devices/+/heartbeat">>, <<"#">>, <<"+/x">>]}, fun() ->
        %% "#" and "+" never match a topic starting with "$" (MQTT 5 4.7.2)
        ?assertNot(?A:excluded(<<"$aws/x">>))
    end),
    tables(#{exclude_topics => [<<"devices/+/heartbeat">>]}, fun() ->
        ?assertNot(?A:excluded(<<"devices/x/data">>)),
        ?assertNot(?A:excluded(<<"devices/x/heartbeat/extra">>))
    end).

%% ── closing while publishers are still writing ─────────────────────

close_racing_increments_loses_nothing_test_() ->
    {timeout, 60, fun() ->
        tables(#{aggregation_window_seconds => 1}, fun() ->
            Parent = self(),
            Stop = erlang:monotonic_time(millisecond) + 2500,
            Pids = [spawn(fun() -> Parent ! {n, self(), loop_pub(Stop, 0)} end)
                    || _ <- lists:seq(1, 8)],
            Emitted = close_loop(Pids, 0),
            Total = lists:sum([receive {n, P, N} -> N end || P <- Pids]),
            {Last, 0} = ?A:close_all(),
            Sum = Emitted + lists:sum([maps:get(<<"quantity">>, E) || E <- Last]),
            ?assertEqual(Total, Sum)
        end)
    end}.

loop_pub(Stop, N) ->
    case erlang:monotonic_time(millisecond) >= Stop of
        true -> N;
        false -> pub(<<"c">>, <<"t">>, #{}), loop_pub(Stop, N + 1)
    end.

close_loop(Pids, Acc) ->
    {Evs, 0} = ?A:close_windows(erlang:system_time(millisecond)),
    Acc1 = Acc + lists:sum([maps:get(<<"quantity">>, E) || E <- Evs]),
    case lists:any(fun erlang:is_process_alive/1, Pids) of
        true -> timer:sleep(30), close_loop(Pids, Acc1);
        false -> Acc1
    end.

%% ── #6: a flusher that stops with usage queued counts it ───────────

flusher_stop_counts_queued_usage_test_() ->
    {timeout, 30, fun() ->
        tables(#{aggregation_window_seconds => 0, flush_count => 1000, flush_interval_ms => 100}, fun() ->
            Http = fun(_, _, _, _) -> {ok, {{"HTTP/1.1", 503, "x"}, [], <<>>}} end,
            {ok, Pid} = aforo_metering_flusher:start_link(#{http => Http, sleep => fun(_) -> ok end,
                                                           rand => fun(_) -> 0 end}),
            unlink(Pid),
            [?A:record({customer, <<"c">>}, <<"PUBLISH">>, <<"t">>, 1, #{}) || _ <- lists:seq(1, 10)],
            ?assert(wait_until(fun() ->
                maps:get(queue_depth, aforo_metering_flusher:status()) =:= 10 end, 3000)),
            Before = aforo_test_util:counter('aforo.metering.events.dropped'),
            ok = gen_server:stop(Pid, crash, 5000),
            ?assertEqual(Before + 10, aforo_test_util:counter('aforo.metering.events.dropped'))
        end)
    end}.

%% ── #8: the mapping service gets the verified attributes ───────────

http_lookup_sends_client_attrs_test_() ->
    {timeout, 20, fun() ->
        Srv = {_, Port, _} = aforo_test_util:start_http_server(fun(_) -> {0, 200, <<"{}">>} end),
        Url = list_to_binary("http://127.0.0.1:" ++ integer_to_list(Port) ++ "/r"),
        aforo_test_util:with_config(#{customer_resolver => <<"http">>, customer_resolver_http_url => Url}),
        ok = aforo_metering_http:start_profile(),
        try
            _ = ?R:http_lookup(<<"d">>, {<<"u">>, #{<<"aforo_customer_id">> => <<"verified">>}}),
            [Body] = aforo_test_util:http_requests(Srv),
            ?assertMatch(#{<<"clientAttrs">> := #{<<"aforo_customer_id">> := <<"verified">>},
                           <<"clientId">> := <<"d">>}, jsone:decode(Body))
        after
            aforo_test_util:stop_http_server(Srv), aforo_test_util:reset_config()
        end
    end}.

%% ── #11: no SNI for an IP literal ──────────────────────────────────

no_sni_for_ip_literal_test() ->
    aforo_test_util:with_config(#{}),
    try
        ?assertEqual(disable, proplists:get_value(server_name_indication,
                     aforo_metering_http:ssl_options(<<"https://10.0.0.5/v1/ingest/batch">>))),
        ?assertEqual(disable, proplists:get_value(server_name_indication,
                     aforo_metering_http:ssl_options(<<"https://[::1]:8443/x">>)))
    after aforo_test_util:reset_config()
    end.
