%%%-------------------------------------------------------------------
%%% @doc
%%% EUnit tests for the flush decisions in aforo_metering (2026-09-21).
%%%
%%% Locks in three rules the flush path depends on:
%%%   * which ingestor responses are permanent (drop) versus transient
%%%     (re-queue and count toward the circuit breaker) -- the same rule as
%%%     the Kong plugin;
%%%   * batches never exceed the ingestor's 1000-event limit;
%%%   * an event without a customerId is never sent, because the ingestor
%%%     validates a batch as a whole and one such event fails all of it.
%%%
%%% Run with:
%%%   rebar3 eunit --module aforo_metering_flush_tests
%%% @end
%%%-------------------------------------------------------------------
-module(aforo_metering_flush_tests).

-include_lib("eunit/include/eunit.hrl").

-define(MOD, aforo_metering).

resp(Code) -> resp(Code, <<>>).
resp(Code, Body) -> {ok, {{"HTTP/1.1", Code, "x"}, [], Body}}.

success_test_() ->
    [?_assertEqual(ok, ?MOD:classify_response(resp(200))),
     ?_assertEqual(ok, ?MOD:classify_response(resp(202)))].

permanent_rejection_test_() ->
    [?_assertEqual({rejected, 400, <<"bad">>}, ?MOD:classify_response(resp(400, <<"bad">>))),
     ?_assertMatch({rejected, 401, _}, ?MOD:classify_response(resp(401))),
     ?_assertMatch({rejected, 403, _}, ?MOD:classify_response(resp(403))),
     ?_assertMatch({rejected, 422, _}, ?MOD:classify_response(resp(422)))].

%% 408 and 429 explicitly invite a retry; 5xx and transport errors are the
%% outages the re-queue exists for. None of these may be dropped.
transient_test_() ->
    [?_assertMatch({transient, _}, ?MOD:classify_response(resp(408))),
     ?_assertMatch({transient, _}, ?MOD:classify_response(resp(429))),
     ?_assertMatch({transient, _}, ?MOD:classify_response(resp(500))),
     ?_assertMatch({transient, _}, ?MOD:classify_response(resp(503))),
     ?_assertMatch({transient, _}, ?MOD:classify_response(resp(301))),
     ?_assertMatch({transient, timeout}, ?MOD:classify_response({error, timeout})),
     ?_assertMatch({transient, _}, ?MOD:classify_response({error, econnrefused}))].

chunk_test_() ->
    L = lists:seq(1, 2500),
    Chunks = ?MOD:chunk(L, 1000),
    [?_assertEqual([], ?MOD:chunk([], 1000)),
     ?_assertEqual([[1, 2, 3]], ?MOD:chunk([1, 2, 3], 1000)),
     ?_assertEqual([1000, 1000, 500], [length(C) || C <- Chunks]),
     %% Order preserved: oldest first, nothing lost or duplicated.
     ?_assertEqual(L, lists:append(Chunks))].

has_customer_test_() ->
    [?_assert(?MOD:has_customer(<<"cust_1">>)),
     ?_assertNot(?MOD:has_customer(undefined)),
     ?_assertNot(?MOD:has_customer(null)),
     ?_assertNot(?MOD:has_customer(<<>>)),
     ?_assertNot(?MOD:has_customer(<<"  ">>)),
     ?_assertNot(?MOD:has_customer("")),
     ?_assertNot(?MOD:has_customer(42))].
