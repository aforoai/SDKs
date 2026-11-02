%%%-------------------------------------------------------------------
%%% G367: https requests verify the server certificate (CA and hostname);
%%% plain http is refused except for loopback or an explicit opt-in.
%%%-------------------------------------------------------------------
-module(aforo_metering_tls_tests).

-include_lib("eunit/include/eunit.hrl").
-include_lib("public_key/include/public_key.hrl").

-define(H, aforo_metering_http).

%% ── URL policy ─────────────────────────────────────────────────────

validate(Url, Extra) ->
    aforo_test_util:with_config(maps:merge(#{ingestor_url => Url}, Extra)),
    try aforo_metering_config:validate() after aforo_test_util:reset_config() end.

url_policy_test_() ->
    [?_assertEqual(ok, validate(<<"https://api.aforo.ai/v1/ingest/batch">>, #{})),
     ?_assertMatch({error, _}, validate(<<"http://api.aforo.ai/v1/ingest/batch">>, #{})),
     ?_assertEqual(ok, validate(<<"http://localhost:8084/v1/ingest/batch">>, #{})),
     ?_assertEqual(ok, validate(<<"http://127.0.0.1:8084/v1/ingest/batch">>, #{})),
     ?_assertEqual(ok, validate(<<"http://[::1]:8084/v1/ingest/batch">>, #{})),
     ?_assertEqual(ok, validate(<<"http://ingestor.internal/v1/ingest/batch">>,
                                #{allow_insecure_http => true})),
     ?_assertMatch({error, _}, validate(<<"ftp://x/y">>, #{})),
     ?_assertMatch({error, _}, validate(<<"not a url">>, #{})),
     ?_assertMatch({error, _}, validate(<<"https://api.aforo.ai/x">>,
                                        #{ca_cert_file => <<"/no/such/file.pem">>}))].

%% The resolver URL follows the same rule.
resolver_url_policy_test() ->
    aforo_test_util:with_config(#{customer_resolver => <<"http">>,
                                  customer_resolver_http_url => <<"http://auth.example/map">>}),
    try ?assertMatch({error, _}, aforo_metering_config:validate())
    after aforo_test_util:reset_config()
    end.

ssl_options_test() ->
    aforo_test_util:with_config(#{}),
    try
        O = ?H:ssl_options(<<"https://api.aforo.ai/v1/ingest/batch">>),
        ?assertEqual(verify_peer, proplists:get_value(verify, O)),
        ?assertEqual("api.aforo.ai", proplists:get_value(server_name_indication, O)),
        ?assertMatch([_ | _], proplists:get_value(cacerts, O)),
        ?assertMatch([{match_fun, _}], proplists:get_value(customize_hostname_check, O)),
        ?assertEqual([], ?H:ssl_options(<<"http://localhost/x">>))
    after aforo_test_util:reset_config()
    end.

%% ── Real TLS handshakes ────────────────────────────────────────────

%% Server certificate for DnsName signed by a fresh test root. Returns
%% {ServerSslOpts, RootDer}.
test_pki({ip, Ip}) -> test_pki_san({iPAddress, Ip});
test_pki(DnsName) -> test_pki_san({dNSName, DnsName}).

test_pki_san(San) ->
    Data = public_key:pkix_test_data(#{
        server_chain => #{root => [{key, {rsa, 2048, 65537}}], intermediates => [],
                          peer => [{key, {rsa, 2048, 65537}},
                                   {extensions,
                                    [#'Extension'{extnID = ?'id-ce-subjectAltName',
                                                  extnValue = [San],
                                                  critical = false}]}]},
        client_chain => #{root => [], intermediates => [], peer => []}}),
    #{server_config := ServerOpts, client_config := ClientOpts} = Data,
    [RootDer | _] = proplists:get_value(cacerts, ClientOpts),
    {ServerOpts, RootDer}.

start_tls_server(ServerOpts) ->
    Parent = self(),
    Pid = spawn(fun() ->
        {ok, L} = ssl:listen(0, [binary, {active, false}, {reuseaddr, true} | ServerOpts]),
        {ok, {_, Port}} = ssl:sockname(L),
        Parent ! {self(), Port},
        loop(L)
    end),
    receive {Pid, Port} -> {Pid, Port} after 5000 -> error(no_tls_server) end.

loop(L) ->
    case ssl:transport_accept(L) of
        {ok, T} ->
            spawn(fun() ->
                case ssl:handshake(T, 5000) of
                    {ok, S} ->
                        _ = ssl:recv(S, 0, 5000),
                        ssl:send(S, <<"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}">>),
                        ssl:close(S);
                    _ -> ok
                end
            end),
            loop(L);
        _ -> ok
    end.

write_pem(Der) ->
    File = filename:join(os:getenv("TMPDIR", "/tmp"),
                         "aforo_tls_test_" ++ integer_to_list(erlang:unique_integer([positive])) ++ ".pem"),
    ok = file:write_file(File, public_key:pem_encode([{'Certificate', Der, not_encrypted}])),
    File.

tls_case(SanName, Cfg, Fun) -> tls_case(SanName, "localhost", Cfg, Fun).

tls_case(SanName, UrlHost, Cfg, Fun) ->
    _ = application:ensure_all_started(ssl),
    {ServerOpts, RootDer} = test_pki(SanName),
    {Pid, Port} = start_tls_server(ServerOpts),
    Pem = write_pem(RootDer),
    aforo_test_util:with_config(Cfg(Pem)),
    ok = ?H:start_profile(),
    try Fun("https://" ++ UrlHost ++ ":" ++ integer_to_list(Port) ++ "/v1/ingest/batch")
    after
        exit(Pid, kill),
        file:delete(Pem),
        aforo_test_util:reset_config()
    end.

trusted_ca_and_matching_host_succeeds_test() ->
    tls_case("localhost", fun(Pem) -> #{ca_cert_file => list_to_binary(Pem)} end, fun(Url) ->
        ?assertMatch({ok, {{_, 200, _}, _, _}}, ?H:request_post(Url, [], <<"{}">>, 5000))
    end).

%% The same server with only the system trust store: refused.
unknown_ca_is_refused_test() ->
    tls_case("localhost", fun(_) -> #{} end, fun(Url) ->
        ?assertMatch({error, _}, ?H:request_post(Url, [], <<"{}">>, 5000))
    end).

%% Trusted CA, but the certificate is for another host: refused.
hostname_mismatch_is_refused_test() ->
    tls_case("other.example", fun(Pem) -> #{ca_cert_file => list_to_binary(Pem)} end, fun(Url) ->
        ?assertMatch({error, _}, ?H:request_post(Url, [], <<"{}">>, 5000))
    end).

%% With only loopback http URLs the CA store is not needed (and not checked).
ca_file_ignored_for_plain_loopback_test() ->
    ?assertEqual(ok, validate(<<"http://127.0.0.1:8084/v1/ingest/batch">>,
                              #{ca_cert_file => <<"/no/such/file.pem">>})).

%% An IP-literal URL still gets the hostname check: a trusted certificate
%% for another name is refused...
ip_literal_wrong_name_is_refused_test() ->
    tls_case("localhost", "127.0.0.1", fun(Pem) -> #{ca_cert_file => list_to_binary(Pem)} end, fun(Url) ->
        ?assertMatch({error, _}, ?H:request_post(Url, [], <<"{}">>, 5000))
    end).

%% ...and one issued for that IP (iPAddress SAN) is accepted.
ip_literal_matching_ip_san_succeeds_test() ->
    tls_case({ip, <<127, 0, 0, 1>>}, "127.0.0.1", fun(Pem) -> #{ca_cert_file => list_to_binary(Pem)} end, fun(Url) ->
        ?assertMatch({ok, {{_, 200, _}, _, _}}, ?H:request_post(Url, [], <<"{}">>, 5000))
    end).

%% ── 2.0.2: a changed CA reaches connections already open ─────────────

%% A keep-alive TLS server: answers every request on a connection.
start_keepalive_tls_server(ServerOpts) ->
    Parent = self(),
    Pid = spawn(fun() ->
        {ok, L} = ssl:listen(0, [binary, {active, false}, {reuseaddr, true} | ServerOpts]),
        {ok, {_, Port}} = ssl:sockname(L),
        Parent ! {self(), Port},
        keepalive_loop(L)
    end),
    receive {Pid, Port} -> {Pid, Port} after 5000 -> error(no_tls_server) end.

keepalive_loop(L) ->
    case ssl:transport_accept(L) of
        {ok, T} ->
            spawn(fun() ->
                case ssl:handshake(T, 5000) of
                    {ok, S} -> serve_keepalive(S);
                    _ -> ok
                end
            end),
            keepalive_loop(L);
        _ -> ok
    end.

serve_keepalive(S) ->
    case ssl:recv(S, 0, 10000) of
        {ok, _} ->
            ok = ssl:send(S, <<"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n"
                               "Connection: keep-alive\r\n\r\n{}">>),
            serve_keepalive(S);
        _ -> ssl:close(S)
    end.

%% The CA is switched to one that does not sign the server certificate.
%% httpc reuses the open connection (its TLS check was done at connect
%% time), so the new CA only takes effect after reset_connections/0 --
%% which on_config_changed calls when ca_cert_file changes.
ca_change_reaches_open_connections_test() ->
    _ = application:ensure_all_started(ssl),
    {ServerOpts, RootDer} = test_pki("localhost"),
    {_OtherOpts, OtherRootDer} = test_pki("localhost"),
    {Pid, Port} = start_keepalive_tls_server(ServerOpts),
    Good = write_pem(RootDer),
    Wrong = write_pem(OtherRootDer),
    Url = "https://localhost:" ++ integer_to_list(Port) ++ "/v1/ingest/batch",
    aforo_test_util:with_config(#{ca_cert_file => list_to_binary(Good)}),
    ok = ?H:start_profile(),
    try
        ?assertMatch({ok, {{_, 200, _}, _, _}}, ?H:request_post(Url, [], <<"{}">>, 5000)),
        aforo_test_util:with_config(#{ca_cert_file => list_to_binary(Wrong)}),
        %% the open connection is reused: the old check still holds
        ?assertMatch({ok, {{_, 200, _}, _, _}}, ?H:request_post(Url, [], <<"{}">>, 5000)),
        ok = ?H:reset_connections(),
        ?assertMatch({error, _}, ?H:request_post(Url, [], <<"{}">>, 5000)),
        aforo_test_util:with_config(#{ca_cert_file => list_to_binary(Good)}),
        ok = ?H:reset_connections(),
        ?assertMatch({ok, {{_, 200, _}, _, _}}, ?H:request_post(Url, [], <<"{}">>, 5000))
    after
        ?H:stop_profile(),
        exit(Pid, kill),
        file:delete(Good),
        file:delete(Wrong),
        aforo_test_util:reset_config()
    end.
