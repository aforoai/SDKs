%%%-------------------------------------------------------------------
%%% 2.0.1: on_config_changed/2 (EMQX 5.8+ calls it on every node when the
%%% plugin config is changed through the Dashboard or REST API).
%%%   * an invalid config is refused and nothing changes;
%%%   * while stopped the config is stored for the next start;
%%%   * while running it is applied in place: new key/URL on the next
%%%     request (a paused delivery retried at once), new queue size and
%%%     batch size, a new window shape closes the open windows -- and
%%%     nothing queued or counted is lost;
%%%   * tenant_id / product_id cannot change while running.
%%%-------------------------------------------------------------------
-module(aforo_metering_reconfig_tests).

-include_lib("eunit/include/eunit.hrl").

-define(M, aforo_metering).
-define(C, aforo_metering_config).
-define(F, aforo_metering_flusher).
-define(A, aforo_metering_aggregator).

%% The config as EMQX hands it to on_config_changed: binary keys.
emqx(Overrides) ->
    maps:merge(#{<<"tenant_id">> => <<"tenant_t">>,
                 <<"product_id">> => <<"prod_p">>,
                 <<"api_key">> => <<"key-1">>,
                 <<"ingestor_url">> => <<"http://127.0.0.1:9/v1/ingest/batch">>,
                 <<"flush_interval_ms">> => 100},
               Overrides).

ok_resp() -> {ok, {{"HTTP/1.1", 202, "x"}, [], <<"{\"data\":{}}">>}}.
err_resp(C) -> {ok, {{"HTTP/1.1", C, "x"}, [], <<>>}}.

%% Fake ingestor recording {Url, ApiKey, Batch} per request; Behaviour
%% (an atomics-backed switch) picks the answer.
fake() ->
    Log = ets:new(reconf_log, [public, bag]),
    Mode = atomics:new(1, []),          %% 0 = accept, N = answer HTTP N
    Http = fun(Url, Headers, Body, _T) ->
        Batch = maps:get(<<"events">>, jsone:decode(Body)),
        Key = proplists:get_value("X-API-Key", Headers),
        R = case atomics:get(Mode, 1) of
            0 -> ok_resp();
            Code -> err_resp(Code)
        end,
        ets:insert(Log, {req, erlang:unique_integer([monotonic]), to_bin(Url), to_bin(Key), Batch, R}),
        R
    end,
    {Http, Log, Mode}.

to_bin(undefined) -> undefined;
to_bin(B) when is_binary(B) -> B;
to_bin(L) -> list_to_binary(L).

%% A running plugin: config snapshot, tables, flusher (with the fake
%% HTTP client; URL and key come from the config) and resolver pool.
running(Cfg, Http, Fun) ->
    ok = ?C:put_snapshot(?C:normalize(emqx(Cfg))),
    ok = aforo_metering_metrics:init(),
    ok = aforo_metering_cache:init(),
    ok = ?A:init(),
    {ok, F} = ?F:start_link(#{http => Http, sleep => fun(_) -> ok end,
                              rand => fun(_) -> 0 end}),
    {ok, P} = aforo_metering_resolver_pool:start_link(),
    unlink(F), unlink(P),
    try Fun()
    after
        [stop(Pid) || Pid <- [F, P]],
        ?A:delete(),
        aforo_metering_cache:delete(),
        ?C:clear_overrides()
    end.

stop(Pid) ->
    Ref = monitor(process, Pid),
    exit(Pid, kill),
    receive {'DOWN', Ref, _, _, _} -> ok after 2000 -> ok end.

reqs(Log) -> lists:keysort(2, ets:tab2list(Log)).

delivered(Log) ->
    [E || {req, _, _, _, B, {ok, {{_, Code, _}, _, _}}} <- reqs(Log), Code < 300, E <- B].

wait_until(Fun, Ms) when Ms =< 0 -> Fun();
wait_until(Fun, Ms) ->
    case Fun() of true -> true; _ -> timer:sleep(20), wait_until(Fun, Ms - 20) end.

pub(N) ->
    ?A:record({customer, <<"c">>}, <<"PUBLISH">>, <<"t">>, 1,
              #{clientid => integer_to_binary(N), qos => 0, retain => false}).

dropped() -> aforo_metering_metrics:val('aforo.metering.events.dropped').

%%--------------------------------------------------------------------
%% Not running
%%--------------------------------------------------------------------

invalid_config_refused_test() ->
    ok = ?C:put_snapshot(?C:normalize(emqx(#{}))),
    try
        {error, Reason} = ?M:on_config_changed(emqx(#{}), emqx(#{<<"api_key">> => <<>>})),
        ?assert(is_binary(Reason)),
        ?assertNotEqual(nomatch, binary:match(Reason, <<"api_key is not set">>)),
        %% the current config is untouched
        ?assertEqual(<<"key-1">>, ?C:api_key())
    after ?C:clear_overrides()
    end.

non_map_refused_test() ->
    ?assertMatch({error, _}, ?M:on_config_changed(#{}, not_a_map)).

stopped_plugin_stores_config_test() ->
    ok = ?C:put_snapshot(?C:normalize(emqx(#{}))),
    try
        undefined = whereis(?F),
        ?assertEqual(ok, ?M:on_config_changed(emqx(#{}), emqx(#{<<"tenant_id">> => <<"tenant_2">>,
                                                                   <<"flush_count">> => 7}))),
        %% while stopped even the tenant may change
        ?assertEqual(<<"tenant_2">>, ?C:tenant_id()),
        ?assertEqual(7, ?C:flush_count())
    after ?C:clear_overrides()
    end.

%%--------------------------------------------------------------------
%% Running
%%--------------------------------------------------------------------

%% A rotated key / moved URL is used on the next request.
new_key_and_url_used_on_next_send_test_() ->
    {timeout, 30, fun() ->
        {Http, Log, _Mode} = fake(),
        running(#{<<"aggregation_window_seconds">> => 0}, Http, fun() ->
            pub(1),
            ok = ?F:flush(),
            [{req, _, Url1, Key1, _, _}] = reqs(Log),
            ?assertEqual({<<"http://127.0.0.1:9/v1/ingest/batch">>, <<"key-1">>}, {Url1, Key1}),
            New = emqx(#{<<"aggregation_window_seconds">> => 0,
                         <<"api_key">> => <<"key-2">>,
                         <<"ingestor_url">> => <<"http://localhost:9/v2/ingest/batch">>}),
            ?assertEqual(ok, ?M:on_config_changed(emqx(#{}), New)),
            pub(2),
            ok = ?F:flush(),
            [_, {req, _, Url2, Key2, _, _}] = reqs(Log),
            ?assertEqual({<<"http://localhost:9/v2/ingest/batch">>, <<"key-2">>}, {Url2, Key2})
        end)
    end}.

%% The usual reason to change the key: the ingestor refuses the old one.
%% Usage queued during the outage is sent once the key is fixed, at once
%% (the pause is cut short), with its original idempotency keys.
fixed_key_resumes_paused_delivery_test_() ->
    {timeout, 30, fun() ->
        {Http, Log, Mode} = fake(),
        atomics:put(Mode, 1, 401),
        running(#{<<"aggregation_window_seconds">> => 0}, Http, fun() ->
            [pub(N) || N <- lists:seq(1, 5)],
            ok = ?F:flush(),
            ?assertEqual(open, maps:get(circuit, ?F:status())),
            ?assertEqual(5, maps:get(queue_depth, ?F:status())),
            Before = [maps:get(<<"idempotencyKey">>, E) || {req, _, _, _, B, _} <- reqs(Log), E <- B],
            atomics:put(Mode, 1, 0),
            ok = ?M:on_config_changed(#{}, emqx(#{<<"aggregation_window_seconds">> => 0,
                                                  <<"api_key">> => <<"key-fixed">>})),
            ?assert(wait_until(fun() -> length(delivered(Log)) =:= 5 end, 5000)),
            Sent = delivered(Log),
            ?assertEqual(lists:usort(Before),
                         lists:usort([maps:get(<<"idempotencyKey">>, E) || E <- Sent])),
            [{req, _, _, LastKey, _, _} | _] = lists:reverse(reqs(Log)),
            ?assertEqual(<<"key-fixed">>, LastKey),
            ?assertEqual(closed, maps:get(circuit, ?F:status()))
        end)
    end}.

%% A smaller max_buffer_size never evicts what is already queued.
shrinking_queue_drops_nothing_test_() ->
    {timeout, 30, fun() ->
        {Http, Log, Mode} = fake(),
        atomics:put(Mode, 1, 503),
        Cfg = #{<<"aggregation_window_seconds">> => 0, <<"flush_count">> => 5},
        running(Cfg, Http, fun() ->
            [pub(N) || N <- lists:seq(1, 40)],
            ok = ?F:flush(),
            ?assertEqual(40, maps:get(queue_depth, ?F:status()) + in_flight()),
            D0 = dropped(),
            ok = ?M:on_config_changed(#{}, emqx(Cfg#{<<"max_buffer_size">> => 10})),
            ?assertEqual(D0, dropped()),
            atomics:put(Mode, 1, 0),
            ok = ?F:flush(),
            ?assert(wait_until(fun() -> length(delivered(Log)) =:= 40 end, 10000)),
            ?assertEqual(D0, dropped()),
            %% drained: the cap is the new size again
            ?assert(wait_until(fun() -> maps:get(max_buffer_size, ?F:status()) =:= 10 end, 5000))
        end)
    end}.

in_flight() -> maps:get(in_flight_events, ?F:status()).

%% flush_count is taken by the flusher.
batch_size_applied_test_() ->
    {timeout, 30, fun() ->
        {Http, Log, _} = fake(),
        Cfg = #{<<"aggregation_window_seconds">> => 0, <<"flush_count">> => 100},
        running(Cfg, Http, fun() ->
            ok = ?M:on_config_changed(#{}, emqx(Cfg#{<<"flush_count">> => 3})),
            [pub(N) || N <- lists:seq(1, 9)],
            ok = ?F:flush(),
            ?assert(wait_until(fun() -> length(delivered(Log)) =:= 9 end, 5000)),
            ?assertEqual([3, 3, 3], [length(B) || {req, _, _, _, B, _} <- reqs(Log)])
        end)
    end}.

%% A new window length closes the open windows at once (partial
%% windows); later usage is counted under the new length. No message is
%% lost or counted twice.
window_change_closes_open_windows_test_() ->
    {timeout, 30, fun() ->
        {Http, Log, _} = fake(),
        Cfg = #{<<"aggregation_window_seconds">> => 3600},
        running(Cfg, Http, fun() ->
            [pub(N) || N <- lists:seq(1, 7)],
            ok = ?F:flush(),
            ?assertEqual([], delivered(Log)),         %% the hour is still open
            ?assertEqual(1, ?A:open_keys()),
            ok = ?M:on_config_changed(#{}, emqx(Cfg#{<<"aggregation_window_seconds">> => 0})),
            ?assertEqual(0, ?A:open_keys()),
            ?assertEqual(0, maps:get(window_ms, ?A:settings())),
            [pub(N) || N <- lists:seq(8, 10)],
            ok = ?F:flush(),
            ?assert(wait_until(fun() -> length(delivered(Log)) =:= 4 end, 5000)),
            Qty = lists:sum([maps:get(<<"quantity">>, E) || E <- delivered(Log)]),
            ?assertEqual(10, Qty),
            Keys = [maps:get(<<"idempotencyKey">>, E) || E <- delivered(Log)],
            ?assertEqual(length(Keys), length(lists:usort(Keys)))
        end)
    end}.

%% exclude_topics is re-read (it used to be read at start only).
exclude_topics_applied_test() ->
    {Http, _Log, _} = fake(),
    running(#{}, Http, fun() ->
        ?assertNot(?A:excluded(<<"internal/x">>)),
        ok = ?M:on_config_changed(#{}, emqx(#{<<"exclude_topics">> => [<<"internal/#">>]})),
        ?assert(?A:excluded(<<"internal/x">>))
    end).

%% The node identity and incarnation (part of every idempotency key)
%% survive a config change.
identity_kept_across_change_test() ->
    {Http, _Log, _} = fake(),
    running(#{}, Http, fun() ->
        S0 = ?A:settings(),
        ok = ?M:on_config_changed(#{}, emqx(#{<<"flush_count">> => 9})),
        S1 = ?A:settings(),
        ?assertEqual(maps:with([node, incarnation], S0), maps:with([node, incarnation], S1)),
        ?assertEqual(9, maps:get(flush_count, S1))
    end).

tenant_change_refused_while_running_test_() ->
    [?_test(begin
         {Http, _Log, _} = fake(),
         running(#{}, Http, fun() ->
             {error, R} = ?M:on_config_changed(#{}, emqx(#{Key => <<"other">>})),
             ?assertNotEqual(nomatch, binary:match(R, <<"stop the plugin">>)),
             ?assertEqual(<<"tenant_t">>, ?C:tenant_id()),
             ?assertEqual(<<"prod_p">>, ?C:product_id())
         end)
     end) || Key <- [<<"tenant_id">>, <<"product_id">>]].

resolver_pool_resized_test() ->
    {Http, _Log, _} = fake(),
    running(#{}, Http, fun() ->
        ok = ?M:on_config_changed(#{}, emqx(#{<<"customer_resolver_http_workers">> => 9,
                                              <<"customer_resolver_http_queue_size">> => 77})),
        St = sys:get_state(aforo_metering_resolver_pool),
        %% #st{queue, queued, running, max_workers, max_queue}
        ?assertEqual({9, 77}, {element(5, St), element(6, St)})
    end).

%% EMQX 5.9 on_health_check/1: a paused delivery is reported.
health_check_reports_paused_delivery_test_() ->
    {timeout, 30, fun() ->
        {Http, _Log, Mode} = fake(),
        atomics:put(Mode, 1, 401),
        running(#{<<"aggregation_window_seconds">> => 0}, Http, fun() ->
            ?assertEqual(ok, ?M:on_health_check(#{})),
            pub(1),
            ok = ?F:flush(),
            ?assertMatch({error, <<"delivery to the Aforo ingestor is paused", _/binary>>},
                         ?M:on_health_check(#{}))
        end)
    end}.

%% The callback EMQX looks up is on <name>_app.
app_module_exports_callbacks_test() ->
    {module, _} = code:ensure_loaded(aforo_metering_app),
    ?assert(erlang:function_exported(aforo_metering_app, on_config_changed, 2)),
    ?assert(erlang:function_exported(aforo_metering_app, on_health_check, 1)).
