%%%-------------------------------------------------------------------
%%% @doc
%%% HTTP client settings shared by the ingestor transport and the http
%%% customer resolver.
%%%
%%% httpc does not verify server certificates unless told to. Every
%%% https request here passes `verify_peer', a CA source (the OS trust
%%% store via public_key:cacerts_get/0, or `ca_cert_file'), hostname
%%% checking with the https match function and SNI. Redirects are never
%%% followed: the API key must not reach another host.
%%%
%%% Requests run on a dedicated httpc profile (`aforo_metering') so they
%%% reuse connections and do not share a pool with other EMQX code.
%%% @end
%%%-------------------------------------------------------------------
-module(aforo_metering_http).

-export([
    start_profile/0,
    stop_profile/0,
    profile/0,
    system_cacerts/0,
    ssl_options/1,
    request_post/4
]).

-define(PROFILE, aforo_metering).

profile() -> ?PROFILE.

-spec start_profile() -> ok.
start_profile() ->
    _ = application:ensure_all_started(inets),
    _ = application:ensure_all_started(ssl),
    case inets:start(httpc, [{profile, ?PROFILE}]) of
        {ok, _} -> ok;
        {error, {already_started, _}} -> ok
    end,
    ok = httpc:set_options([{max_sessions, 4}, {max_keep_alive_length, 100},
                            {keep_alive_timeout, 60000}], ?PROFILE),
    ok.

-spec stop_profile() -> ok.
stop_profile() ->
    try inets:stop(httpc, ?PROFILE) catch _:_ -> ok end,
    ok.

-spec system_cacerts() -> {ok, list()} | {error, term()}.
system_cacerts() ->
    try public_key:cacerts_get() of
        [] -> {error, empty};
        Certs when is_list(Certs) -> {ok, Certs}
    catch C:R -> {error, {C, R}}
    end.

%% SSL options for a request to Url. `[]' for plain http (validation has
%% already refused http for anything but loopback unless the operator
%% opted in).
-spec ssl_options(binary() | string()) -> list().
ssl_options(Url) ->
    #{scheme := Scheme, host := Host0} = uri_string:parse(to_bin(Url)),
    case string:lowercase(to_bin(Scheme)) of
        <<"https">> ->
            Host = binary_to_list(strip_brackets(to_bin(Host0))),
            %% SNI carries a DNS name only (RFC 6066 3); for an IP literal it
            %% is switched off and the certificate is checked against the
            %% IP (iPAddress SAN) by the hostname check.
            Sni = case inet:parse_address(Host) of
                {ok, _} -> disable;
                {error, _} -> Host
            end,
            [{verify, verify_peer},
             ca_option(),
             {depth, 10},
             {server_name_indication, Sni},
             {customize_hostname_check,
              [{match_fun, public_key:pkix_verify_hostname_match_fun(https)}]}];
        _ -> []
    end.

ca_option() ->
    case aforo_metering_config:ca_cert_file() of
        <<>> ->
            case system_cacerts() of
                {ok, Certs} -> {cacerts, Certs};
                %% validate/0 refuses to load in this case; fail closed if
                %% reached anyway (an empty CA list rejects every server).
                {error, _} -> {cacerts, []}
            end;
        File -> {cacertfile, binary_to_list(File)}
    end.

%% POST with a deadline, no redirects, binary body. httpc's `timeout'
%% starts once the request is sent, so the worst case is
%% connect_timeout + TimeoutMs; callers that need a hard bound run this
%% in a process they kill at their deadline (the flusher's drain and the
%% resolver pool do). Returns httpc's result unchanged.
-spec request_post(binary() | string(), [{string(), string()}], iodata(), pos_integer()) ->
    {ok, {{string(), integer(), string()}, list(), binary()}} | {error, term()}.
request_post(Url, Headers, Body, TimeoutMs) ->
    UrlS = to_list(Url),
    ConnectTimeout = min(TimeoutMs, aforo_metering_config:connect_timeout_ms()),
    HttpOpts = [{timeout, TimeoutMs},
                {connect_timeout, ConnectTimeout},
                {autoredirect, false},
                {ssl, ssl_options(UrlS)}],
    try
        httpc:request(post, {UrlS, Headers, "application/json", iolist_to_binary(Body)},
                      HttpOpts, [{body_format, binary}], ?PROFILE)
    catch C:R -> {error, {C, R}}
    end.

strip_brackets(<<"[", Rest/binary>>) -> binary:part(Rest, 0, max(0, byte_size(Rest) - 1));
strip_brackets(B) -> B.

to_bin(B) when is_binary(B) -> B;
to_bin(L) when is_list(L) -> unicode:characters_to_binary(L).

to_list(B) when is_binary(B) -> binary_to_list(B);
to_list(L) when is_list(L) -> L.
