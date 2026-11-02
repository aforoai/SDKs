%%%-------------------------------------------------------------------
%%% Delivery rules (aforo-metering-sdks/contract/TRANSPORT-SPEC.md).
%%%
%%% Carries forward the 2026-09-21 rules (which answers are permanent,
%%% the 1000-event batch limit) and adds the spec's: Retry-After in both
%%% forms, full-jitter backoff, 401/403/3xx as outages, 413 split,
%%% per-event retryable errors, the shared deadline.
%%%-------------------------------------------------------------------
-module(aforo_metering_transport_tests).

-include_lib("eunit/include/eunit.hrl").

-define(T, aforo_metering_transport).

resp(Code) -> resp(Code, [], <<>>).
resp(Code, Headers, Body) -> {ok, {{"HTTP/1.1", Code, "x"}, Headers, Body}}.

ev(N) -> #{<<"customerId">> => <<"c">>, <<"metricName">> => <<"m">>, <<"quantity">> => 1,
           <<"occurredAt">> => <<"2026-10-27T00:00:00.000Z">>,
           <<"idempotencyKey">> => integer_to_binary(N)}.

%% Scripted fake HTTP: Script is a list of responses (or funs of the
%% decoded batch); records every call.
opts(Script) ->
    Calls = ets:new(calls, [public, ordered_set]),
    Ctr = counters:new(1, []),
    ScriptRef = ets:new(script, [public]),
    ets:insert(ScriptRef, {s, Script}),
    Http = fun(_Url, Headers, Body, Timeout) ->
        counters:add(Ctr, 1, 1),
        N = counters:get(Ctr, 1),
        Batch = maps:get(<<"events">>, jsone:decode(Body)),
        ets:insert(Calls, {N, Headers, Batch, Timeout}),
        [{s, S}] = ets:lookup(ScriptRef, s),
        case S of
            [] -> resp(202, [], <<"{\"data\":{\"accepted\":1}}">>);
            [H | T] ->
                ets:insert(ScriptRef, {s, T}),
                case H of
                    F when is_function(F, 1) -> F(Batch);
                    R -> R
                end
        end
    end,
    {#{url => "https://ingest.example/v1/ingest/batch", api_key => <<"k">>, tenant => <<"t">>,
       batch_size => 500, timeout_ms => 10000, max_retries => 3, deadline => infinity,
       sleep => fun(_) -> ok end, rand => fun(Max) -> Max end, http => Http}, Calls}.

calls(Calls) -> ets:tab2list(Calls).

%% ── classification (carried forward) ───────────────────────────────

success_test_() ->
    [?_assertMatch({ok, _}, ?T:classify(resp(200))),
     ?_assertMatch({ok, _}, ?T:classify(resp(202)))].

permanent_rejection_test_() ->
    [?_assertEqual({rejected, 400, <<"bad">>}, ?T:classify(resp(400, [], <<"bad">>))),
     ?_assertMatch({rejected, 404, _}, ?T:classify(resp(404))),
     ?_assertMatch({rejected, 422, _}, ?T:classify(resp(422)))].

transient_test_() ->
    [?_assertMatch({transient, _, _}, ?T:classify(resp(408))),
     ?_assertMatch({transient, _, _}, ?T:classify(resp(429))),
     ?_assertMatch({transient, _, _}, ?T:classify(resp(500))),
     ?_assertMatch({transient, _, _}, ?T:classify(resp(507))),
     ?_assertMatch({transient, timeout, _}, ?T:classify({error, timeout})),
     ?_assertMatch({transient, _, _}, ?T:classify({error, econnrefused}))].

%% A bad or revoked key, or a redirect, must not lose the queued usage.
auth_and_redirect_are_outages_test_() ->
    [?_assertEqual({outage, {auth, 401}}, ?T:classify(resp(401))),
     ?_assertEqual({outage, {auth, 403}}, ?T:classify(resp(403))),
     ?_assertEqual({outage, {redirect, 301, <<"evil.example">>}},
                   ?T:classify(resp(301, [{"location", "https://evil.example/x"}], <<>>))),
     ?_assertEqual(too_large, ?T:classify(resp(413)))].

chunk_test_() ->
    L = lists:seq(1, 2500),
    Chunks = ?T:chunk(L, 1000),
    [?_assertEqual([], ?T:chunk([], 1000)),
     ?_assertEqual([[1, 2, 3]], ?T:chunk([1, 2, 3], 1000)),
     ?_assertEqual([1000, 1000, 500], [length(C) || C <- Chunks]),
     ?_assertEqual(L, lists:append(Chunks))].

split_by_size_test() ->
    Big = [maps:put(<<"pad">>, binary:copy(<<"x">>, 1000), ev(N)) || N <- lists:seq(1, 50)],
    Parts = ?T:split_by_size(Big, 10000),
    ?assert(length(Parts) > 1),
    ?assertEqual(Big, lists:append(Parts)),
    [?assert(byte_size(jsone:encode(#{<<"events">> => P})) =< 10000) || P <- Parts].

%% ── Retry-After and backoff ────────────────────────────────────────

retry_after_test_() ->
    Now = 1800000000,
    {{Y, Mo, D}, {H, Mi, S}} = calendar:system_time_to_universal_time(Now + 3, second),
    Months = {"Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"},
    Days = {"Mon","Tue","Wed","Thu","Fri","Sat","Sun"},
    Date = lists:flatten(io_lib:format("~s, ~2..0B ~s ~4..0B ~2..0B:~2..0B:~2..0B GMT",
        [element(calendar:day_of_the_week(Y, Mo, D), Days), D, element(Mo, Months), Y, H, Mi, S])),
    [?_assertEqual(2000, ?T:parse_retry_after([{"retry-after", "2"}], Now)),
     ?_assertEqual(1500, ?T:parse_retry_after([{"Retry-After", "1.5"}], Now)),
     ?_assertEqual(3000, ?T:parse_retry_after([{"retry-after", Date}], Now)),
     ?_assertEqual(0, ?T:parse_retry_after([{"retry-after", "Sun, 06 Nov 1994 08:49:37 GMT"}], Now)),
     ?_assertEqual(undefined, ?T:parse_retry_after([{"retry-after", "soon"}], Now)),
     ?_assertEqual(undefined, ?T:parse_retry_after([], Now))].

backoff_test_() ->
    Max = #{rand => fun(M) -> M end},
    Zero = #{rand => fun(_) -> 0 end},
    [?_assertEqual(500, ?T:backoff_ms(0, undefined, Max)),
     ?_assertEqual(4000, ?T:backoff_ms(3, undefined, Max)),
     ?_assertEqual(30000, ?T:backoff_ms(10, undefined, Max)),
     ?_assertEqual(0, ?T:backoff_ms(2, undefined, Zero)),
     %% max(retryAfter, jittered), capped at 60 s
     ?_assertEqual(7000, ?T:backoff_ms(0, 7000, Max)),
     ?_assertEqual(60000, ?T:backoff_ms(0, 120000, Zero))].

%% ── send/2 ─────────────────────────────────────────────────────────

all_sent_test() ->
    {O, Calls} = opts([]),
    R = ?T:send([ev(1), ev(2)], O),
    ?assertMatch(#{sent := 2, rejected := [], requeue := [], outage := undefined}, R),
    [{1, Headers, _, _}] = calls(Calls),
    ?assertEqual("k", proplists:get_value("X-API-Key", Headers)),
    ?assertEqual(undefined, proplists:get_value("Authorization", Headers)).

batches_never_exceed_batch_size_test() ->
    {O, Calls} = opts([]),
    Evs = [ev(N) || N <- lists:seq(1, 1200)],
    #{sent := 1200} = ?T:send(Evs, O#{batch_size => 500}),
    ?assertEqual([500, 500, 200], [length(B) || {_, _, B, _} <- calls(Calls)]).

transient_then_ok_keeps_keys_test() ->
    {O, Calls} = opts([resp(503), resp(429, [{"retry-after", "1"}], <<>>)]),
    Slept = ets:new(slept, [public, bag]),
    R = ?T:send([ev(1), ev(2)], O#{sleep => fun(Ms) -> ets:insert(Slept, {s, Ms}) end}),
    ?assertMatch(#{sent := 2, outage := undefined}, R),
    Keys = [[maps:get(<<"idempotencyKey">>, E) || E <- B] || {_, _, B, _} <- calls(Calls)],
    ?assertEqual([[<<"1">>, <<"2">>]], lists:usort(Keys)),
    ?assertEqual(3, length(Keys)),
    %% second pause honoured Retry-After (1 s) over the jittered 1000 ms ceiling
    ?assert(lists:member({s, 1000}, ets:lookup(Slept, s))).

retries_exhausted_is_outage_and_requeues_everything_test() ->
    {O, Calls} = opts([resp(500), resp(500), resp(500), resp(500)]),
    Evs = [ev(N) || N <- lists:seq(1, 700)],
    R = ?T:send(Evs, O),
    ?assertMatch(#{sent := 0, outage := {http_status, 500}}, R),
    ?assertEqual(Evs, maps:get(requeue, R)),
    %% first attempt + 3 retries, then stop: the second batch is not tried
    ?assertEqual(4, length(calls(Calls))).

auth_failure_requeues_without_retry_test() ->
    {O, Calls} = opts([resp(401)]),
    R = ?T:send([ev(1)], O),
    ?assertMatch(#{outage := {auth, 401}, requeue := [_], rejected := []}, R),
    ?assertEqual(1, length(calls(Calls))).

rejection_drops_batch_test() ->
    {O, _} = opts([resp(400, [], <<"{\"title\":\"bad\"}">>)]),
    R = ?T:send([ev(1), ev(2)], O),
    ?assertMatch(#{sent := 0, outage := undefined, requeue := []}, R),
    ?assertEqual(2, length(maps:get(rejected, R))).

too_large_splits_in_half_test() ->
    {O, Calls} = opts([resp(413)]),
    R = ?T:send([ev(N) || N <- lists:seq(1, 4)], O),
    ?assertMatch(#{sent := 4, rejected := []}, R),
    ?assertEqual([4, 2, 2], [length(B) || {_, _, B, _} <- calls(Calls)]).

single_event_413_is_rejected_test() ->
    {O, _} = opts([resp(413)]),
    ?assertMatch(#{sent := 0, rejected := [_]}, ?T:send([ev(1)], O)).

per_event_errors_test() ->
    Body = jsone:encode(#{<<"success">> => true,
                          <<"data">> => #{<<"accepted">> => 1, <<"failed">> => 2,
                                          <<"errors">> => [#{<<"index">> => 1, <<"retryable">> => true,
                                                             <<"message">> => <<"busy">>},
                                                           #{<<"index">> => 2, <<"retryable">> => false,
                                                             <<"message">> => <<"bad">>}]}}),
    {O, Calls} = opts([resp(202, [], Body)]),
    R = ?T:send([ev(1), ev(2), ev(3)], O),
    ?assertMatch(#{sent := 2, outage := undefined}, R),
    ?assertEqual([ev(3)], maps:get(rejected, R)),
    %% the retryable one was re-sent alone, with its key
    [_, {2, _, Resent, _}] = calls(Calls),
    ?assertEqual([<<"2">>], [maps:get(<<"idempotencyKey">>, E) || E <- Resent]).

deadline_bounds_request_timeout_test() ->
    {O, Calls} = opts([]),
    Deadline = erlang:monotonic_time(millisecond) + 300,
    #{sent := 1} = ?T:send([ev(1)], O#{deadline => Deadline}),
    [{1, _, _, Timeout}] = calls(Calls),
    ?assert(Timeout =< 300).

passed_deadline_requeues_test() ->
    {O, Calls} = opts([]),
    R = ?T:send([ev(1)], O#{deadline => erlang:monotonic_time(millisecond) - 1}),
    ?assertMatch(#{outage := deadline, requeue := [_]}, R),
    ?assertEqual([], calls(Calls)).

%% No sleep may run past the deadline: the retry is abandoned instead.
retry_does_not_sleep_past_deadline_test() ->
    {O, _} = opts([resp(503)]),
    Deadline = erlang:monotonic_time(millisecond) + 100,
    R = ?T:send([ev(1)], O#{deadline => Deadline, rand => fun(_) -> 5000 end,
                            sleep => fun(_) -> error(slept_past_deadline) end}),
    ?assertMatch(#{outage := {http_status, 503}, requeue := [_]}, R).
