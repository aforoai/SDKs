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
%%% Requests run on a dedicated httpc profile so they reuse connections
%%% and do not share a pool with other EMQX code. httpc keeps a
%%% keep-alive connection per host and port, and an open TLS connection
%%% keeps the certificate check it passed when it was opened: a request
%%% with new `ssl' options still goes out on it. So when the TLS or URL
%%% settings change (`reset_connections/0', from on_config_changed) new
%%% requests move to a fresh profile -- two names alternate,
%%% `aforo_metering' and `aforo_metering_b' -- and the old one, with its
%%% open connections, is stopped once a request started on it can no
%%% longer be running (connect timeout + request timeout + 5 s).
%%% Requests already in flight finish on the old profile.
%%% @end
%%%-------------------------------------------------------------------
-module(aforo_metering_http).

-export([
    start_profile/0,
    stop_profile/0,
    reset_connections/0,
    profile/0,
    system_cacerts/0,
    ssl_options/1,
    request_post/4
]).

-define(PROFILE, aforo_metering).
-define(PROFILE_B, aforo_metering_b).
-define(CURRENT, {?MODULE, profile}).
-define(RETIRE_MARGIN_MS, 5000).

%% The profile new requests use.
-spec profile() -> atom().
profile() -> persistent_term:get(?CURRENT, ?PROFILE).

-spec start_profile() -> ok.
start_profile() ->
    _ = application:ensure_all_started(inets),
    _ = application:ensure_all_started(ssl),
    start_one(profile()).

-spec stop_profile() -> ok.
stop_profile() ->
    stop_one(?PROFILE),
    stop_one(?PROFILE_B),
    _ = persistent_term:erase(?CURRENT),
    ok.

%% Send new requests on a fresh profile, so no connection opened under
%% the previous TLS / URL settings is reused; stop the previous profile
%% once nothing started on it can still be running.
-spec reset_connections() -> ok.
reset_connections() ->
    _ = application:ensure_all_started(inets),
    _ = application:ensure_all_started(ssl),
    Old = profile(),
    New = other(Old),
    %% New may still exist from an earlier reset; start it empty.
    stop_one(New),
    ok = start_one(New),
    persistent_term:put(?CURRENT, New),
    Grace = aforo_metering_config:connect_timeout_ms()
            + max(aforo_metering_config:request_timeout_ms(),
                  aforo_metering_config:http_resolver_timeout_ms())
            + ?RETIRE_MARGIN_MS,
    _ = spawn(fun() -> retire(Old, Grace) end),
    ok.

%% Skipped if Old became current again meanwhile (a second reset
%% restarted it empty).
retire(Old, Grace) ->
    timer:sleep(Grace),
    case profile() of
        Old -> ok;
        _ -> stop_one(Old)
    end.

other(?PROFILE) -> ?PROFILE_B;
other(_) -> ?PROFILE.

start_one(P) ->
    case inets:start(httpc, [{profile, P}]) of
        {ok, _} -> ok;
        {error, {already_started, _}} -> ok
    end,
    ok = httpc:set_options([{max_sessions, 4}, {max_keep_alive_length, 100},
                            {keep_alive_timeout, 60000}], P),
    ok.

stop_one(P) ->
    try inets:stop(httpc, P) catch _:_ -> ok end,
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
            %% For an IP literal the option is left out: OTP then checks the
            %% certificate against the host it connects to and sends no SNI
            %% (RFC 6066 3 allows DNS names only). Never `disable' -- that
            %% also switches the hostname check off.
            Sni = case inet:parse_address(Host) of
                {ok, _} -> [];
                {error, _} -> [{server_name_indication, Host}]
            end,
            [{verify, verify_peer},
             ca_option(),
             {depth, 10},
             {customize_hostname_check,
              [{match_fun, public_key:pkix_verify_hostname_match_fun(https)}]}] ++ Sni;
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
                      HttpOpts, [{body_format, binary}], profile())
    catch C:R -> {error, {C, R}}
    end.

strip_brackets(<<"[", Rest/binary>>) -> binary:part(Rest, 0, max(0, byte_size(Rest) - 1));
strip_brackets(B) -> B.

to_bin(B) when is_binary(B) -> B;
to_bin(L) when is_list(L) -> unicode:characters_to_binary(L).

to_list(B) when is_binary(B) -> binary_to_list(B);
to_list(L) when is_list(L) -> L.
