%%%-------------------------------------------------------------------
%%% @doc
%%% Customer-ID resolution for the Aforo MQTT Metering plugin.
%%%
%%% Backends (`customer_resolver'):
%%%
%%%   client_attrs (default) -- read one attribute from the client
%%%       attributes EMQX authentication set (`client_attrs' in
%%%       ClientInfo, EMQX 5.7.0+). With JWT authentication the
%%%       attribute comes from the token's `client_attrs' claim after
%%%       EMQX has verified the signature; with HTTP authentication it
%%%       comes from the auth service's response. The attribute name is
%%%       `customer_resolver_client_attr' (default "aforo_customer_id").
%%%       Do not also set that attribute from `mqtt.client_attrs_init'
%%%       using a client-supplied field (username, clientid, ...): that
%%%       would make it client-chosen again.
%%%
%%%   http -- POST {clientId, username, clientAttrs, tenantId} to the
%%%       operator's mapping service; expects {"customerId": "..."} (bare
%%%       or under "data"). Runs in aforo_metering_resolver_pool, never in
%%%       the client's process. clientId and username are what the client
%%%       sent; clientAttrs are what EMQX authentication set. The service
%%%       must map from clientAttrs, or from a clientId/username broker
%%%       authentication has pinned.
%%%
%%%   username | clientid_prefix | jwt_unverified -- values the MQTT
%%%       client chooses (jwt_unverified decodes a token WITHOUT checking
%%%       its signature). The plugin refuses to load with these unless
%%%       `unsafe_trust_client_identity = true', which is only correct
%%%       when broker authentication already pins that value to the
%%%       client (e.g. username/password auth where each username belongs
%%%       to one customer).
%%%
%%% Results are cached per (tenant, clientid) in aforo_metering_cache,
%%% negative results included.
%%% @end
%%%-------------------------------------------------------------------
-module(aforo_metering_customer_resolver).

-include("aforo_metering_emqx.hrl").

-export([
    resolve_connect/2,
    resolve/1,
    lookup/1,
    on_disconnect/2,
    resolve_sync/3,
    http_lookup/2,
    parse_http_response/1
]).

%% A pending lookup may wait as long as usage is held for it
%% (`customer_resolver_pending_max_seconds'); a queued request can sit
%% behind a backlog for a while.
pending_ttl_ms() -> aforo_metering_config:pending_max_ms().

%% Called on client.connected: resolves for this connection (identity
%% may have changed since the last one). Returns the customer, `pending'
%% (async lookup started, no earlier customer to use meanwhile) or
%% `undefined'.
-spec resolve_connect(map(), map()) -> binary() | pending | undefined.
resolve_connect(ClientInfo, ConnInfo) ->
    Tenant = aforo_metering_config:tenant_id(),
    ClientId = clientid_bin(ClientInfo),
    Conn = conn_marker(ConnInfo),
    case aforo_metering_config:customer_resolver() of
        <<"http">> -> start_async(Tenant, ClientId, Conn, ClientInfo);
        Backend ->
            C = resolve_sync(Backend, ClientInfo, ConnInfo),
            ok = aforo_metering_cache:put(Tenant, ClientId, C, Conn, username(ClientInfo)),
            C
    end.

%% Called by hooks that carry ClientInfo (deliver, subscribe, ...): the
%% cache first, then the backend.
-spec resolve(map()) -> binary() | pending | undefined.
resolve(ClientInfo) ->
    Tenant = aforo_metering_config:tenant_id(),
    ClientId = clientid_bin(ClientInfo),
    case aforo_metering_cache:get(Tenant, ClientId) of
        {ok, C} -> C;
        pending -> pending;
        negative -> undefined;
        not_found ->
            case aforo_metering_config:customer_resolver() of
                <<"http">> ->
                    Conn = case aforo_metering_cache:retry_inputs(Tenant, ClientId) of
                        {ok, C0, _} -> C0;
                        none -> undefined
                    end,
                    start_async(Tenant, ClientId, Conn, ClientInfo);
                Backend ->
                    C = resolve_sync(Backend, ClientInfo, #{}),
                    ok = aforo_metering_cache:put(Tenant, ClientId, C, undefined, username(ClientInfo)),
                    C
            end
    end.

%% message.publish only carries the clientid. For the http backend an
%% expired miss of a still-connected client is retried with the username
%% stored at connect, so a publish-only device is not lost for the whole
%% connection after one failed lookup.
-spec lookup(binary()) -> binary() | pending | undefined.
lookup(ClientId) ->
    Tenant = aforo_metering_config:tenant_id(),
    case aforo_metering_cache:get(Tenant, ClientId) of
        {ok, C} -> C;
        pending -> pending;
        negative -> undefined;
        not_found ->
            case aforo_metering_config:customer_resolver() =:= <<"http">> andalso
                 aforo_metering_cache:retry_inputs(Tenant, ClientId) of
                {ok, Conn, User} ->
                    start_async(Tenant, ClientId, Conn,
                                #{clientid => ClientId, username => User});
                _ -> undefined
            end
    end.

%% Keep the entry for two windows plus one flush interval so the
%% windows this client contributed to can still be attributed. Only the
%% connection that owns the entry expires it (session takeover).
-spec on_disconnect(map(), map()) -> ok.
on_disconnect(ClientInfo, ConnInfo) ->
    Keep = 2 * max(aforo_metering_config:aggregation_window_ms(), 1000)
           + aforo_metering_config:flush_interval_ms(),
    aforo_metering_cache:expire_after(aforo_metering_config:tenant_id(),
                                      clientid_bin(ClientInfo), conn_marker(ConnInfo), Keep).

%% Identifies one connection of a clientid (EMQX sets connected_at in
%% ConnInfo). `undefined' when absent.
conn_marker(ConnInfo) when is_map(ConnInfo) -> maps:get(connected_at, ConnInfo, undefined);
conn_marker(_) -> undefined.

start_async(Tenant, ClientId, Conn, ClientInfo) ->
    Ref = make_ref(),
    Username = username(ClientInfo),
    ok = aforo_metering_cache:put_pending(Tenant, ClientId, Ref, pending_ttl_ms(), {Conn, Username}),
    Attrs = case maps:get(client_attrs, ClientInfo, #{}) of
        M when is_map(M) -> M;
        _ -> #{}
    end,
    ok = aforo_metering_resolver_pool:request(Tenant, ClientId, {Username, Attrs}, Ref),
    case aforo_metering_cache:get(Tenant, ClientId) of
        {ok, Prev} -> Prev;   %% previous customer used until the answer arrives
        _ -> pending
    end.

username(ClientInfo) ->
    case maps:get(username, ClientInfo, <<>>) of
        undefined -> <<>>;
        U -> safe_bin(U)
    end.

%% ── Synchronous backends (cheap: map lookups only) ─────────────────

-spec resolve_sync(binary(), map(), map()) -> binary() | undefined.
resolve_sync(<<"client_attrs">>, ClientInfo, _ConnInfo) ->
    Attrs = case maps:get(client_attrs, ClientInfo, #{}) of
        M when is_map(M) -> M;
        _ -> #{}
    end,
    non_blank(maps:get(aforo_metering_config:client_attr(), Attrs, undefined));

resolve_sync(<<"username">>, ClientInfo, _ConnInfo) ->
    non_blank(maps:get(username, ClientInfo, undefined));

resolve_sync(<<"clientid_prefix">>, ClientInfo, _ConnInfo) ->
    Sep = aforo_metering_config:clientid_separator(),
    case clientid_bin(ClientInfo) of
        <<>> -> undefined;
        ClientId ->
            case binary:split(ClientId, Sep, [global]) of
                [<<"cust">>, CustomerId | _] -> non_blank(CustomerId);
                _ -> undefined
            end
    end;

resolve_sync(<<"jwt_unverified">>, _ClientInfo, ConnInfo) ->
    Props = maps:get(conn_props, ConnInfo, #{}),
    case maps:get('Authentication-Data', Props, undefined) of
        Token when is_binary(Token) ->
            case decode_jwt_claim(Token, aforo_metering_config:jwt_claim()) of
                {ok, Claim} -> non_blank(Claim);
                _ -> undefined
            end;
        _ -> undefined
    end;

%% validate/0 refuses to load with any other backend; never fall back
%% to a client-chosen value.
resolve_sync(_, _ClientInfo, _ConnInfo) ->
    undefined.

%% ── http backend (runs in a resolver-pool worker) ──────────────────

%% clientId and username are what the client sent; clientAttrs are the
%% attributes EMQX authentication set (the verified identity, when the
%% broker's authenticator provides one).
-spec http_lookup(binary(), {binary(), map()} | binary()) -> binary() | undefined.
http_lookup(ClientId, Username) when is_binary(Username) ->
    http_lookup(ClientId, {Username, #{}});
http_lookup(ClientId, {Username, Attrs}) ->
    Url = aforo_metering_config:http_resolver_url(),
    Body = jsone:encode(#{<<"clientId">> => ClientId,
                          <<"username">> => Username,
                          <<"clientAttrs">> => Attrs,
                          <<"tenantId">> => aforo_metering_config:tenant_id()}),
    %% The Aforo ingest API key is never sent to the mapping service.
    Headers = case aforo_metering_config:get(customer_resolver_http_authorization, <<>>) of
        <<>> -> [];
        "" -> [];
        Auth -> [{"Authorization", to_list(Auth)}]
    end,
    Result = aforo_metering_http:request_post(Url, Headers, Body,
                                              aforo_metering_config:http_resolver_timeout_ms()),
    parse_http_response(Result).

-spec parse_http_response(term()) -> binary() | undefined.
parse_http_response({ok, {{_, Code, _}, _, RespBody}}) when Code >= 200, Code < 300 ->
    case jsone:try_decode(iolist_to_binary(RespBody)) of
        {ok, #{<<"customerId">> := C}, _} -> non_blank(C);
        {ok, #{<<"data">> := #{<<"customerId">> := C}}, _} -> non_blank(C);
        _ -> undefined
    end;
parse_http_response(_) ->
    undefined.

%% ── JWT decoding for jwt_unverified (NO signature check) ───────────

decode_jwt_claim(Token, Claim) ->
    case binary:split(Token, <<".">>, [global]) of
        [_Header, Payload, _Sig] ->
            try
                Json = base64:decode(pad_base64url(Payload)),
                case jsone:try_decode(Json) of
                    {ok, Map, _} when is_map(Map) ->
                        case maps:get(Claim, Map, undefined) of
                            V when is_binary(V) -> {ok, V};
                            _ -> error
                        end;
                    _ -> error
                end
            catch _:_ -> error
            end;
        _ -> error
    end.

pad_base64url(Bin) ->
    Pad = case byte_size(Bin) rem 4 of 2 -> <<"==">>; 3 -> <<"=">>; _ -> <<>> end,
    Replaced = binary:replace(binary:replace(Bin, <<"-">>, <<"+">>, [global]),
                              <<"_">>, <<"/">>, [global]),
    <<Replaced/binary, Pad/binary>>.

%% ── Helpers ────────────────────────────────────────────────────────

clientid_bin(ClientInfo) -> safe_bin(maps:get(clientid, ClientInfo, undefined)).

non_blank(V) ->
    case safe_bin(V) of
        <<>> -> undefined;
        B ->
            case string:trim(B) of
                <<>> -> undefined;
                _ -> B
            end
    end.

safe_bin(undefined) -> <<>>;
safe_bin(null) -> <<>>;
safe_bin(B) when is_binary(B) -> B;
safe_bin(L) when is_list(L) ->
    try unicode:characters_to_binary(L) of
        B when is_binary(B) -> B;
        _ -> <<>>
    catch _:_ -> <<>>
    end;
safe_bin(A) when is_atom(A) -> atom_to_binary(A, utf8);
safe_bin(N) when is_integer(N) -> integer_to_binary(N);
safe_bin(_) -> <<>>.

to_list(B) when is_binary(B) -> binary_to_list(B);
to_list(L) when is_list(L) -> L.
