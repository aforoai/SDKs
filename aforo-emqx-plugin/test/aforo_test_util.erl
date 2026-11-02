%%%-------------------------------------------------------------------
%%% Test helpers: config overrides, a tiny scripted HTTP server and the
%%% Node mock ingestor (aforo-metering-sdks/mock-ingestor).
%%%-------------------------------------------------------------------
-module(aforo_test_util).

-export([
    with_config/1,
    reset_config/0,
    start_http_server/1,
    stop_http_server/1,
    http_requests/1,
    start_mock_ingestor/0,
    stop_mock_ingestor/1,
    mock_get/2,
    mock_post/3,
    mock_delete/2,
    counter/1,
    await_window_room/0,
    await_window_room/1
]).

with_config(Map) ->
    aforo_metering_config:set_overrides(maps:merge(base_config(), Map)).

reset_config() ->
    aforo_metering_config:clear_overrides().

base_config() ->
    #{tenant_id => <<"tenant_t">>, product_id => <<"prod_p">>, api_key => <<"test-key">>,
      ingestor_url => <<"http://127.0.0.1:9/v1/ingest/batch">>}.

counter(Name) -> aforo_metering_metrics:val(Name).

%%--------------------------------------------------------------------
%% Scripted HTTP/1.1 server. Handler(ReqBody) -> {DelayMs, Status, Body}.
%% Records every request body. Connection: close per request.
%%--------------------------------------------------------------------

start_http_server(Handler) ->
    Parent = self(),
    Pid = spawn(fun() ->
        {ok, L} = gen_tcp:listen(0, [binary, {active, false}, {reuseaddr, true},
                                     {ip, {127, 0, 0, 1}}]),
        {ok, Port} = inet:port(L),
        Log = ets:new(log, [public, bag]),
        Parent ! {self(), {port, Port, Log}},
        accept_loop(L, Handler, Log)
    end),
    receive {Pid, {port, Port, Log}} -> {Pid, Port, Log} after 5000 -> error(no_server) end.

accept_loop(L, Handler, Log) ->
    case gen_tcp:accept(L) of
        {ok, S} ->
            spawn(fun() -> serve(S, Handler, Log) end),
            accept_loop(L, Handler, Log);
        _ -> ok
    end.

serve(S, Handler, Log) ->
    case read_request(S, <<>>) of
        {ok, Body} ->
            ets:insert(Log, {req, erlang:monotonic_time(millisecond), Body}),
            {Delay, Status, RespBody} = Handler(Body),
            timer:sleep(Delay),
            Resp = [<<"HTTP/1.1 ">>, integer_to_binary(Status), <<" X\r\n">>,
                    <<"Content-Type: application/json\r\nConnection: close\r\n">>,
                    <<"Content-Length: ">>, integer_to_binary(byte_size(RespBody)), <<"\r\n\r\n">>,
                    RespBody],
            _ = gen_tcp:send(S, Resp),
            gen_tcp:close(S);
        _ -> gen_tcp:close(S)
    end.

read_request(S, Acc) ->
    case binary:split(Acc, <<"\r\n\r\n">>) of
        [Head, Rest] ->
            Len = content_length(Head),
            read_body(S, Rest, Len);
        _ ->
            case gen_tcp:recv(S, 0, 5000) of
                {ok, D} -> read_request(S, <<Acc/binary, D/binary>>);
                E -> E
            end
    end.

read_body(_S, Got, Len) when byte_size(Got) >= Len -> {ok, Got};
read_body(S, Got, Len) ->
    case gen_tcp:recv(S, 0, 5000) of
        {ok, D} -> read_body(S, <<Got/binary, D/binary>>, Len);
        E -> E
    end.

content_length(Head) ->
    Lines = binary:split(Head, <<"\r\n">>, [global]),
    lists:foldl(fun(Line, Acc) ->
        case binary:split(Line, <<":">>) of
            [K, V] ->
                case string:lowercase(K) of
                    <<"content-length">> -> binary_to_integer(string:trim(V));
                    _ -> Acc
                end;
            _ -> Acc
        end
    end, 0, Lines).

stop_http_server({Pid, _Port, _Log}) -> exit(Pid, kill), ok.

http_requests({_Pid, _Port, Log}) ->
    [B || {req, _, B} <- lists:keysort(2, ets:lookup(Log, req))].

%%--------------------------------------------------------------------
%% Mock ingestor (Node). Skips the calling test when node is missing.
%%--------------------------------------------------------------------

mock_dir() ->
    case os:getenv("AFORO_MOCK_INGESTOR") of
        %% rebar3 runs eunit from the plugin directory; the mock ships in
        %% the same repository (aforo-metering-sdks/mock-ingestor).
        false -> filename:absname("../aforo-metering-sdks/mock-ingestor");
        D -> D
    end.

start_mock_ingestor() ->
    Node = os:find_executable("node"),
    Bin = filename:join([mock_dir(), "bin", "mock-ingestor.mjs"]),
    case Node =/= false andalso filelib:is_regular(Bin) of
        false -> {skip, "node or mock-ingestor not available"};
        true ->
            Port = open_port({spawn_executable, Node},
                             [{args, [Bin, "--port", "0", "--api-key", "test-key"]},
                              binary, {line, 4096}, exit_status, use_stdio]),
            receive
                {Port, {data, {eol, Line}}} ->
                    #{<<"port">> := P} = jsone:decode(Line),
                    {ok, Port, P}
            after 10000 -> error(mock_ingestor_did_not_start)
            end
    end.

stop_mock_ingestor(Port) ->
    try port_close(Port) catch _:_ -> ok end,
    ok.

mock_get(P, Path) ->
    {ok, {{_, 200, _}, _, Body}} =
        httpc:request(get, {"http://127.0.0.1:" ++ integer_to_list(P) ++ Path, []},
                      [], [{body_format, binary}]),
    jsone:decode(Body).

mock_post(P, Path, Json) ->
    {ok, {{_, Code, _}, _, _}} =
        httpc:request(post, {"http://127.0.0.1:" ++ integer_to_list(P) ++ Path, [],
                             "application/json", jsone:encode(Json)},
                      [], [{body_format, binary}]),
    Code.

mock_delete(P, Path) ->
    {ok, {{_, Code, _}, _, _}} =
        httpc:request(delete, {"http://127.0.0.1:" ++ integer_to_list(P) ++ Path, []},
                      [], [{body_format, binary}]),
    Code.

%% Tests that expect all their messages in ONE 60 s window wait until at
%% least RoomMs of the current window remain, so a slow run never splits
%% them across a minute boundary.
await_window_room() -> await_window_room(3000).

await_window_room(RoomMs) ->
    Left = 60000 - (erlang:system_time(millisecond) rem 60000),
    case Left < RoomMs of
        true -> timer:sleep(Left + 50);
        false -> ok
    end.
