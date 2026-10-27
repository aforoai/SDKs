%%%-------------------------------------------------------------------
%%% G365 / G366: one process owns the queue and the cap; exactly one
%%% request is in flight; outages requeue with the same keys; shutdown
%%% is bounded.
%%%-------------------------------------------------------------------
-module(aforo_metering_flusher_tests).

-include_lib("eunit/include/eunit.hrl").

-define(F, aforo_metering_flusher).
-define(A, aforo_metering_aggregator).

%% Fake ingestor: Behaviour(Batch) -> response; records batches and the
%% highest number of concurrent requests.
fake(Behaviour) ->
    Log = ets:new(fake_log, [public, bag]),
    Ctr = counters:new(2, []),
    Http = fun(_Url, _H, Body, _T) ->
        counters:add(Ctr, 1, 1),
        Cur = counters:get(Ctr, 1),
        case Cur > counters:get(Ctr, 2) of true -> counters:put(Ctr, 2, Cur); false -> ok end,
        Batch = maps:get(<<"events">>, jsone:decode(Body)),
        R = Behaviour(Batch),
        ets:insert(Log, {batch, erlang:unique_integer([monotonic]), Batch, R}),
        counters:sub(Ctr, 1, 1),
        R
    end,
    {Http, Log, Ctr}.

ok_resp() -> {ok, {{"HTTP/1.1", 202, "x"}, [], <<"{\"data\":{}}">>}}.
err_resp(C) -> {ok, {{"HTTP/1.1", C, "x"}, [], <<>>}}.

run(Cfg, Http, Fun) ->
    aforo_test_util:with_config(maps:merge(#{flush_interval_ms => 100}, Cfg)),
    ok = aforo_metering_cache:init(),
    ok = ?A:init(),
    {ok, Pid} = ?F:start_link(#{http => Http, sleep => fun(_) -> ok end,
                                rand => fun(_) -> 0 end}),
    unlink(Pid),
    try Fun(Pid)
    after
        exit(Pid, kill),
        Ref = monitor(process, Pid),
        receive {'DOWN', Ref, _, _, _} -> ok after 2000 -> ok end,
        ?A:delete(),
        aforo_metering_cache:delete(),
        aforo_test_util:reset_config()
    end.

delivered(Log) ->
    [E || {batch, _, B, {ok, {{_, Code, _}, _, _}}} <- ets:tab2list(Log), Code < 300, E <- B].

wait_until(Fun, Ms) when Ms =< 0 -> Fun();
wait_until(Fun, Ms) ->
    case Fun() of true -> true; _ -> timer:sleep(20), wait_until(Fun, Ms - 20) end.

pub(N) ->
    ?A:record({customer, <<"c">>}, <<"PUBLISH">>, <<"t">>, 1,
              #{clientid => integer_to_binary(N), qos => 0, retain => false}).

%% G366: 20 publishers, flush_count 10, slow ingestor -- never more than
%% one request at a time, and nothing lost.
single_request_in_flight_test_() ->
    {timeout, 120, fun single_request_in_flight/0}.

single_request_in_flight() ->
    {Http, Log, Ctr} = fake(fun(_) -> timer:sleep(15), ok_resp() end),
    run(#{aggregation_window_seconds => 0, flush_count => 10}, Http, fun(_) ->
        Parent = self(),
        Pids = [spawn(fun() -> [pub(I * 1000 + N) || N <- lists:seq(1, 100)], Parent ! {d, self()} end)
                || I <- lists:seq(1, 20)],
        [receive {d, P} -> ok end || P <- Pids],
        ?assert(wait_until(fun() -> length(delivered(Log)) =:= 2000 end, 100000)),
        ?assertEqual(1, counters:get(Ctr, 2)),
        Keys = [maps:get(<<"idempotencyKey">>, E) || E <- delivered(Log)],
        ?assertEqual(2000, length(lists:usort(Keys)))
    end).

%% G365: the queue is bounded by its owner. Closed windows beyond the
%% queue's room wait in the counter table instead of evicting queued
%% events, so an outage loses nothing until the counter cap is reached.
queue_is_bounded_without_loss_test() ->
    {Http, _Log, _} = fake(fun(_) -> err_resp(503) end),
    run(#{aggregation_window_seconds => 0, max_buffer_size => 50, flush_count => 1000}, Http, fun(_) ->
        Before = aforo_test_util:counter('aforo.metering.events.dropped'),
        [pub(N) || N <- lists:seq(1, 200)],
        ?assert(wait_until(fun() -> maps:get(queue_depth, ?F:status()) =:= 50 end, 5000)),
        ?assertEqual(open, maps:get(circuit, ?F:status())),
        timer:sleep(300),
        ?assert(maps:get(queue_depth, ?F:status()) =< 50),
        %% everything is either queued, in flight or still counted
        St = ?F:status(),
        ?assertEqual(200, maps:get(queue_depth, St) + maps:get(in_flight_events, St)
                          + ?A:open_keys()),
        ?assertEqual(Before, aforo_test_util:counter('aforo.metering.events.dropped'))
    end).

%% A requeue that overflows the queue evicts only the oldest overflow.
requeue_overflow_evicts_oldest_test() ->
    Gate = atomics:new(1, []),
    {Http, Log, _} = fake(fun(_) ->
        case atomics:get(Gate, 1) of 0 -> err_resp(503); _ -> ok_resp() end
    end),
    run(#{aggregation_window_seconds => 0, max_buffer_size => 10, flush_count => 10}, Http, fun(_) ->
        Before = aforo_test_util:counter('aforo.metering.events.dropped'),
        [pub(N) || N <- lists:seq(1, 10)],
        ?assert(wait_until(fun() -> maps:get(circuit, ?F:status()) =:= open end, 3000)),
        [pub(N) || N <- lists:seq(11, 15)],
        atomics:put(Gate, 1, 1),
        ok = ?F:flush(),
        ?assert(wait_until(fun() ->
            St = ?F:status(),
            ?A:open_keys() =:= 0 andalso maps:get(queue_depth, St) =:= 0
                andalso not maps:get(in_flight, St) end, 5000)),
        ?assertEqual(15, length(delivered(Log)) + aforo_test_util:counter('aforo.metering.events.dropped') - Before)
    end).

%% After an outage the same events, with the same keys, are delivered.
outage_then_recovery_keeps_keys_test() ->
    Down = atomics:new(1, []),
    atomics:put(Down, 1, 1),
    {Http, Log, _} = fake(fun(_) ->
        case atomics:get(Down, 1) of 1 -> err_resp(503); 0 -> ok_resp() end
    end),
    run(#{aggregation_window_seconds => 0, flush_count => 100}, Http, fun(_) ->
        [pub(N) || N <- lists:seq(1, 30)],
        ?assert(wait_until(fun() -> maps:get(circuit, ?F:status()) =:= open end, 3000)),
        FirstKeys = lists:usort([maps:get(<<"idempotencyKey">>, E)
                                 || {batch, _, B, _} <- ets:tab2list(Log), E <- B]),
        ?assertEqual(30, length(FirstKeys)),
        atomics:put(Down, 1, 0),
        ok = ?F:flush(),   %% one attempt now, even with the breaker open
        ?assert(wait_until(fun() -> length(delivered(Log)) =:= 30 end, 3000)),
        ?assertEqual(FirstKeys, lists:usort([maps:get(<<"idempotencyKey">>, E) || E <- delivered(Log)])),
        ?assertEqual(closed, maps:get(circuit, ?F:status()))
    end).

%% Open aggregation windows are sent at shutdown.
drain_sends_open_windows_test() ->
    {Http, Log, _} = fake(fun(_) -> ok_resp() end),
    run(#{}, Http, fun(_) ->
        aforo_test_util:await_window_room(),
        [pub(N) || N <- lists:seq(1, 500)],
        #{sent := 1, dropped := 0} = ?F:drain(2000),
        [E] = delivered(Log),
        ?assertEqual(500, maps:get(<<"quantity">>, E))
    end).

%% A hung ingestor cannot hold shutdown past the deadline.
drain_is_bounded_test() ->
    {Http, _Log, _} = fake(fun(_) -> timer:sleep(5000), ok_resp() end),
    run(#{request_timeout_ms => 10000}, Http, fun(_) ->
        pub(1),
        T0 = erlang:monotonic_time(millisecond),
        R = ?F:drain(500),
        Took = erlang:monotonic_time(millisecond) - T0,
        ?assert(Took < 1500),
        ?assertMatch(#{sent := 0}, R)
    end).

cooldown_formula_test_() ->
    Max = fun(M) -> M end,
    Zero = fun(_) -> 0 end,
    [?_assertEqual(5000, ?F:cooldown_ms(0, Max)),
     ?_assertEqual(20000, ?F:cooldown_ms(2, Max)),
     ?_assertEqual(300000, ?F:cooldown_ms(12, Max)),
     ?_assertEqual(250, ?F:cooldown_ms(3, Zero))].
