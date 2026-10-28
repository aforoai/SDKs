%%%-------------------------------------------------------------------
%%% Delivery against the shared mock ingestor
%%% (aforo-metering-sdks/mock-ingestor, Node). Uses the real httpc
%%% client, the real aggregated event shape and the ingest contract the
%%% mock enforces. Skipped when node is not installed.
%%%-------------------------------------------------------------------
-module(aforo_metering_mock_ingestor_tests).

-include_lib("eunit/include/eunit.hrl").

-define(T, aforo_metering_transport).
-define(A, aforo_metering_aggregator).

mock_test_() ->
    {setup,
     fun() ->
         _ = application:ensure_all_started(inets),
         aforo_test_util:start_mock_ingestor()
     end,
     fun({ok, Port, _}) -> aforo_test_util:stop_mock_ingestor(Port);
        (_) -> ok
     end,
     fun({skip, Why}) -> [{"mock ingestor unavailable: " ++ Why, fun() -> ok end}];
        ({ok, _Port, P}) ->
         {inorder, [
             {"aggregated events pass the ingest contract", fun() -> accepted(P) end},
             {"outage then recovery: nothing lost, keys kept", fun() -> outage(P) end},
             {"429 with Retry-After is honoured", fun() -> retry_after(P) end},
             {"dripping body is cut off by the total deadline", fun() -> drip(P) end},
             {"redirect is never followed", fun() -> redirect(P) end},
             {"401 is an outage, not a drop", fun() -> auth(P) end},
             {"413 splits the batch", fun() -> too_large(P) end},
             {"per-event retryable errors are re-sent", fun() -> per_event(P) end}
         ]}
     end}.

url(P) -> "http://127.0.0.1:" ++ integer_to_list(P) ++ "/v1/ingest/batch".

opts(P, Extra) ->
    maps:merge(#{url => url(P), api_key => <<"test-key">>, tenant => <<"tenant_t">>,
                 batch_size => 500, timeout_ms => 2000, max_retries => 3, deadline => infinity,
                 sleep => fun timer:sleep/1, rand => fun(_) -> 10 end,
                 http => fun aforo_metering_http:request_post/4}, Extra).

reset(P) -> 200 = aforo_test_util:mock_post(P, "/__control/reset", #{}).
faults(P, L) -> 200 = aforo_test_util:mock_post(P, "/__control/faults", #{<<"faults">> => L}).
state(P) -> aforo_test_util:mock_get(P, "/__control/state").

%% Real events from the aggregator.
events(N) ->
    aforo_test_util:with_config(#{aggregate_by_topic => true}),
    ok = aforo_metering_cache:init(),
    ok = ?A:init(),
    try
        [?A:record({customer, <<"cust_", (integer_to_binary(I rem 7))/binary>>}, <<"PUBLISH">>,
                   <<"t/", (integer_to_binary(I))/binary>>, 12, #{}) || I <- lists:seq(1, N)],
        {Evs, 0} = ?A:close_all(),
        Evs
    after
        ?A:delete(),
        aforo_metering_cache:delete(),
        aforo_test_util:reset_config(),
        ok = aforo_metering_http:start_profile()
    end.

keys(Evs) -> lists:sort([maps:get(<<"idempotencyKey">>, E) || E <- Evs]).

accepted(P) ->
    reset(P),
    Evs = events(40),
    R = ?T:send(Evs, opts(P, #{})),
    ?assertMatch(#{sent := 40, rejected := [], outage := undefined}, R),
    S = state(P),
    ?assertEqual(40, maps:get(<<"acceptedCount">>, S)).

outage(P) ->
    reset(P),
    faults(P, [#{<<"status">> => 503, <<"times">> => 2}, #{<<"reset">> => true}]),
    Evs = events(10),
    R = ?T:send(Evs, opts(P, #{})),
    ?assertMatch(#{sent := 10, outage := undefined}, R),
    S = state(P),
    Sent = [K || #{<<"idempotencyKeys">> := Ks} <- maps:get(<<"requests">>, S), K <- Ks],
    %% every attempt carried the same keys
    ?assertEqual(keys(Evs), lists:usort(Sent)),
    ?assertEqual(10, maps:get(<<"acceptedCount">>, S)).

retry_after(P) ->
    reset(P),
    faults(P, [#{<<"status">> => 429, <<"retryAfter">> => <<"1">>}]),
    T0 = erlang:monotonic_time(millisecond),
    R = ?T:send(events(3), opts(P, #{})),
    ?assertMatch(#{sent := 3}, R),
    ?assert(erlang:monotonic_time(millisecond) - T0 >= 1000).

drip(P) ->
    reset(P),
    faults(P, [#{<<"dripMs">> => 200, <<"times">> => -1}]),
    T0 = erlang:monotonic_time(millisecond),
    R = ?T:send(events(3), opts(P, #{timeout_ms => 500, max_retries => 0})),
    Took = erlang:monotonic_time(millisecond) - T0,
    200 = aforo_test_util:mock_delete(P, "/__control/faults"),
    ?assertMatch(#{outage := _, requeue := [_, _, _]}, R),
    ?assert(Took < 2000).

redirect(P) ->
    reset(P),
    faults(P, [#{<<"status">> => 307, <<"location">> => <<"http://127.0.0.1:1/steal">>}]),
    R = ?T:send(events(2), opts(P, #{})),
    ?assertMatch(#{outage := {redirect, 307, <<"127.0.0.1">>}, requeue := [_, _]}, R),
    ?assertEqual(1, length(maps:get(<<"requests">>, state(P)))).

auth(P) ->
    reset(P),
    R = ?T:send(events(2), opts(P, #{api_key => <<"wrong-key">>})),
    ?assertMatch(#{outage := {auth, 401}, requeue := [_, _], rejected := []}, R).

too_large(P) ->
    reset(P),
    faults(P, [#{<<"status">> => 413}]),
    R = ?T:send(events(4), opts(P, #{})),
    ?assertMatch(#{sent := 4, rejected := []}, R),
    ?assertEqual(4, maps:get(<<"acceptedCount">>, state(P))).

per_event(P) ->
    reset(P),
    faults(P, [#{<<"perEvent">> => [#{<<"index">> => 0, <<"message">> => <<"busy">>,
                                      <<"retryable">> => true}]}]),
    Evs = events(3),
    R = ?T:send(Evs, opts(P, #{})),
    ?assertMatch(#{sent := 3, rejected := []}, R),
    ?assertEqual(3, maps:get(<<"uniqueKeys">>, state(P))).
