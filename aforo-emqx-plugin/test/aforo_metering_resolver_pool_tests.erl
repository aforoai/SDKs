%%%-------------------------------------------------------------------
%%% G364: the http customer lookup never blocks the client's process,
%%% and "no customer" answers are cached for the negative TTL.
%%%-------------------------------------------------------------------
-module(aforo_metering_resolver_pool_tests).

-include_lib("eunit/include/eunit.hrl").

-define(R, aforo_metering_customer_resolver).

run(Handler, Cfg, Fun) ->
    Srv = aforo_test_util:start_http_server(Handler),
    {_, Port, _} = Srv,
    Url = list_to_binary("http://127.0.0.1:" ++ integer_to_list(Port) ++ "/resolve"),
    aforo_test_util:with_config(maps:merge(#{customer_resolver => <<"http">>,
                                             customer_resolver_http_url => Url,
                                             customer_resolver_http_timeout_ms => 3000}, Cfg)),
    ok = aforo_metering_http:start_profile(),
    ok = aforo_metering_cache:init(),
    {ok, Pool} = aforo_metering_resolver_pool:start_link(),
    unlink(Pool),
    try Fun(Srv)
    after
        exit(Pool, kill),
        wait_dead(Pool),
        aforo_metering_cache:delete(),
        aforo_test_util:stop_http_server(Srv),
        aforo_test_util:reset_config()
    end.

wait_dead(Pid) ->
    Ref = monitor(process, Pid),
    receive {'DOWN', Ref, _, _, _} -> ok after 2000 -> ok end.

wait_until(Fun, Ms) when Ms =< 0 -> Fun();
wait_until(Fun, Ms) ->
    case Fun() of
        true -> true;
        _ -> timer:sleep(20), wait_until(Fun, Ms - 20)
    end.

ci(Id) -> #{clientid => Id, username => <<"user-", Id/binary>>}.

%% The mapping service takes 1.5 s; CONNECT must not wait for it.
connect_does_not_block_on_slow_service_test() ->
    run(fun(_) -> {1500, 200, <<"{\"customerId\":\"cust_slow\"}">>} end, #{}, fun(_Srv) ->
        T0 = erlang:monotonic_time(millisecond),
        ?assertEqual(pending, ?R:resolve_connect(ci(<<"d1">>), #{})),
        ?assert(erlang:monotonic_time(millisecond) - T0 < 200),
        ?assertEqual(pending, ?R:lookup(<<"d1">>)),
        ?assert(wait_until(fun() -> ?R:lookup(<<"d1">>) =:= <<"cust_slow">> end, 4000))
    end).

%% Before 2.0.0 an empty answer was never cached: every event called the
%% service again.
negative_answer_is_cached_test() ->
    run(fun(_) -> {0, 200, <<"{}">>} end, #{}, fun(Srv) ->
        pending = ?R:resolve(ci(<<"d2">>)),
        ?assert(wait_until(fun() -> length(aforo_test_util:http_requests(Srv)) =:= 1 end, 3000)),
        ?assert(wait_until(fun() -> ?R:lookup(<<"d2">>) =:= undefined end, 3000)),
        [?assertEqual(undefined, ?R:resolve(ci(<<"d2">>))) || _ <- lists:seq(1, 50)],
        timer:sleep(200),
        ?assertEqual(1, length(aforo_test_util:http_requests(Srv)))
    end).

failing_service_is_cached_as_miss_test() ->
    run(fun(_) -> {0, 503, <<>>} end, #{}, fun(Srv) ->
        pending = ?R:resolve(ci(<<"d3">>)),
        ?assert(wait_until(fun() -> ?R:lookup(<<"d3">>) =:= undefined end, 3000)),
        [?R:resolve(ci(<<"d3">>)) || _ <- lists:seq(1, 20)],
        timer:sleep(200),
        ?assertEqual(1, length(aforo_test_util:http_requests(Srv)))
    end).

negative_ttl_expires_test() ->
    run(fun(_) -> {0, 200, <<"{}">>} end, #{customer_resolver_negative_ttl_seconds => 1}, fun(Srv) ->
        pending = ?R:resolve(ci(<<"d4">>)),
        ?assert(wait_until(fun() -> ?R:lookup(<<"d4">>) =:= undefined andalso
                                    length(aforo_test_util:http_requests(Srv)) =:= 1 end, 3000)),
        timer:sleep(1100),
        pending = ?R:resolve(ci(<<"d4">>)),
        ?assert(wait_until(fun() -> length(aforo_test_util:http_requests(Srv)) =:= 2 end, 3000))
    end).

%% No more than `customer_resolver_http_workers' lookups run at once.
concurrency_is_bounded_test() ->
    Active = counters:new(2, []),
    Handler = fun(_) ->
        counters:add(Active, 1, 1),
        Now = counters:get(Active, 1),
        case Now > counters:get(Active, 2) of
            true -> counters:put(Active, 2, Now);
            false -> ok
        end,
        timer:sleep(150),
        counters:sub(Active, 1, 1),
        {0, 200, <<"{\"customerId\":\"c\"}">>}
    end,
    run(Handler, #{customer_resolver_http_workers => 2}, fun(Srv) ->
        [pending = ?R:resolve(ci(integer_to_binary(N))) || N <- lists:seq(1, 8)],
        ?assert(wait_until(fun() -> length(aforo_test_util:http_requests(Srv)) =:= 8 end, 5000)),
        ?assert(counters:get(Active, 2) =< 2)
    end).

full_queue_refuses_and_counts_test() ->
    run(fun(_) -> {500, 200, <<"{\"customerId\":\"c\"}">>} end,
        #{customer_resolver_http_workers => 1, customer_resolver_http_queue_size => 2}, fun(_Srv) ->
        Before = aforo_test_util:counter('aforo.metering.resolver.dropped'),
        [?R:resolve(ci(integer_to_binary(N))) || N <- lists:seq(1, 10)],
        ?assert(wait_until(fun() ->
            aforo_test_util:counter('aforo.metering.resolver.dropped') - Before >= 6 end, 2000))
    end).

%% A reconnect starts a new lookup; the older connection's slow answer
%% must not overwrite it.
stale_answer_is_ignored_test() ->
    Tenant = <<"tenant_t">>,
    aforo_test_util:with_config(#{}),
    ok = aforo_metering_cache:init(),
    try
        Old = make_ref(), New = make_ref(),
        aforo_metering_cache:put_pending(Tenant, <<"d">>, Old, 60000, {undefined, <<>>}),
        aforo_metering_cache:put_pending(Tenant, <<"d">>, New, 60000, {undefined, <<>>}),
        ?assertEqual(stale, aforo_metering_cache:complete_pending(Tenant, <<"d">>, Old, <<"old">>)),
        ok = aforo_metering_cache:complete_pending(Tenant, <<"d">>, New, <<"new">>),
        ?assertEqual({ok, <<"new">>}, aforo_metering_cache:get(Tenant, <<"d">>))
    after
        aforo_metering_cache:delete(),
        aforo_test_util:reset_config()
    end.

%% The Aforo ingest key is never sent to the mapping service.
api_key_not_sent_to_mapping_service_test() ->
    Parent = self(),
    {Pid, Port, _} = Srv = start_raw_capture(Parent),
    Url = list_to_binary("http://127.0.0.1:" ++ integer_to_list(Port) ++ "/r"),
    aforo_test_util:with_config(#{customer_resolver => <<"http">>, customer_resolver_http_url => Url}),
    ok = aforo_metering_http:start_profile(),
    try
        _ = ?R:http_lookup(<<"d">>, <<"u">>),
        receive {raw, Req} ->
            ?assertEqual(nomatch, binary:match(Req, <<"test-key">>)),
            ?assertEqual(nomatch, binary:match(string:lowercase(Req), <<"x-api-key">>))
        after 3000 -> error(no_request)
        end
    after
        exit(Pid, kill),
        _ = Srv,
        aforo_test_util:reset_config()
    end.

start_raw_capture(Parent) ->
    Self = self(),
    Pid = spawn(fun() ->
        {ok, L} = gen_tcp:listen(0, [binary, {active, false}, {ip, {127, 0, 0, 1}}]),
        {ok, Port} = inet:port(L),
        Self ! {port, Port},
        {ok, S} = gen_tcp:accept(L),
        {ok, D} = gen_tcp:recv(S, 0, 3000),
        Parent ! {raw, D},
        gen_tcp:send(S, <<"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}">>),
        gen_tcp:close(S),
        receive stop -> ok end
    end),
    receive {port, P} -> {Pid, P, undefined} end.
