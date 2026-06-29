%%%-------------------------------------------------------------------
%%% @doc
%%% Pluggable customer-ID resolver for the Aforo MQTT Metering plugin.
%%%
%%% Selects the resolution strategy at runtime via the
%%% `aforo_metering.customer_resolver` config knob. Available backends:
%%%
%%%   username        — MQTT CONNECT username field (default; matches the
%%%                     pre-Session-5 inline behaviour)
%%%   clientid_prefix — parse `cust_<id>_<rest>` from clientid, returns <id>
%%%                     (configurable via `customer_resolver_clientid_separator`)
%%%   jwt             — decode the JWT in CONNECT v5's
%%%                     Authentication Data property; returns the `sub` claim
%%%                     (or whichever claim is configured)
%%%   http            — POST {clientId, username} to a configured auth
%%%                     service URL; expects {"customerId": "..."} in the
%%%                     response body. Uses aforo_metering_cache to
%%%                     amortise across the lifetime of a connection.
%%%
%%% All backends are wrapped by aforo_metering_cache so the heavy paths
%%% (jwt decode, http call) run at most once per (tenant, clientid).
%%% @end
%%%-------------------------------------------------------------------
-module(aforo_metering_customer_resolver).

-include_lib("emqx/include/logger.hrl").

-export([resolve/2, resolve/3, invalidate/2]).

-spec resolve(map(), map()) -> binary() | undefined.
resolve(ClientInfo, ConnInfo) ->
    TenantId = tenant_id_bin(),
    ClientId = clientid_bin(ClientInfo),
    case aforo_metering_cache:get(TenantId, ClientId) of
        {ok, CustomerId} -> CustomerId;
        not_found ->
            CustomerId = resolve_uncached(backend(), ClientInfo, ConnInfo),
            ok = aforo_metering_cache:put(TenantId, ClientId, CustomerId),
            CustomerId
    end.

-spec resolve(binary(), map(), map()) -> binary() | undefined.
resolve(ExplicitBackend, ClientInfo, ConnInfo) ->
    %% Override path used by tests / callers that want to bypass the configured backend.
    resolve_uncached(ExplicitBackend, ClientInfo, ConnInfo).

-spec invalidate(map()) -> ok.
invalidate(ClientInfo) ->
    aforo_metering_cache:invalidate(tenant_id_bin(), clientid_bin(ClientInfo)).

%% ── Backends ───────────────────────────────────────────────────────

resolve_uncached(<<"username">>, ClientInfo, _ConnInfo) ->
    case maps:get(username, ClientInfo, undefined) of
        undefined -> undefined;
        <<>>      -> undefined;
        Username when is_binary(Username) -> Username;
        Other     -> safe_bin(Other)
    end;

resolve_uncached(<<"clientid_prefix">>, ClientInfo, _ConnInfo) ->
    Sep = clientid_separator(),
    case clientid_bin(ClientInfo) of
        <<>> -> undefined;
        ClientId ->
            case binary:split(ClientId, Sep, [global]) of
                [<<"cust">>, CustomerId | _] when CustomerId =/= <<>> -> CustomerId;
                _ -> undefined
            end
    end;

resolve_uncached(<<"jwt">>, _ClientInfo, ConnInfo) ->
    %% MQTT 5 CONNECT carries Authentication Data in conn properties.
    Props = maps:get(conn_props, ConnInfo, #{}),
    case maps:get('Authentication-Data', Props, undefined) of
        undefined -> undefined;
        TokenBin when is_binary(TokenBin) ->
            case decode_jwt_claim(TokenBin, jwt_claim()) of
                {ok, Claim} -> Claim;
                _ -> undefined
            end;
        _ -> undefined
    end;

resolve_uncached(<<"http">>, ClientInfo, _ConnInfo) ->
    case http_resolver_url() of
        <<>> -> undefined;
        Url ->
            ClientId = clientid_bin(ClientInfo),
            Username = case maps:get(username, ClientInfo, <<>>) of
                undefined -> <<>>;
                U -> U
            end,
            Body = jsone:encode(#{
                <<"clientId">> => ClientId,
                <<"username">> => Username,
                <<"tenantId">> => tenant_id_bin()
            }),
            Headers = [
                {"Content-Type", "application/json"},
                {"Authorization", "Bearer " ++ binary_to_list(api_key_bin())}
            ],
            UrlList = binary_to_list(Url),
            try httpc:request(post, {UrlList, Headers, "application/json", Body},
                              [{timeout, 5000}], []) of
                {ok, {{_, Code, _}, _, RespBody}} when Code >= 200, Code < 300 ->
                    case jsone:try_decode(iolist_to_binary(RespBody)) of
                        {ok, #{<<"customerId">> := CustomerId}, _} when is_binary(CustomerId) ->
                            CustomerId;
                        _ -> undefined
                    end;
                _ -> undefined
            catch _:_ -> undefined
            end
    end;

resolve_uncached(_, ClientInfo, ConnInfo) ->
    %% Unknown backend → fall back to username for backward compat.
    resolve_uncached(<<"username">>, ClientInfo, ConnInfo).

%% ── JWT (RFC 7519) — decode body claim only, signature verification
%% is intentionally out of scope for the metering plugin (the broker's
%% main auth chain owns signature verification). ──────────────────────

decode_jwt_claim(Token, Claim) ->
    case binary:split(Token, <<".">>, [global]) of
        [_Header, Payload, _Sig] ->
            try
                Padded = pad_base64url(Payload),
                Json = base64:decode(Padded),
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
    %% base64url → base64 padding
    Mod = byte_size(Bin) rem 4,
    Pad = case Mod of 0 -> <<>>; 2 -> <<"==">>; 3 -> <<"=">>; _ -> <<>> end,
    Replaced = binary:replace(binary:replace(Bin, <<"-">>, <<"+">>, [global]),
                              <<"_">>, <<"/">>, [global]),
    <<Replaced/binary, Pad/binary>>.

%% ── Helpers ────────────────────────────────────────────────────────

clientid_bin(ClientInfo) ->
    case maps:get(clientid, ClientInfo, undefined) of
        undefined -> <<>>;
        Bin when is_binary(Bin) -> Bin;
        Other -> safe_bin(Other)
    end.

safe_bin(undefined) -> <<>>;
safe_bin(B) when is_binary(B) -> B;
safe_bin(L) when is_list(L) -> list_to_binary(L);
safe_bin(A) when is_atom(A) -> atom_to_binary(A, utf8);
safe_bin(N) when is_integer(N) -> integer_to_binary(N);
safe_bin(_) -> <<>>.

%% ── Config accessors (read from emqx_conf with safe defaults) ──────

backend() ->
    case get_cfg(customer_resolver, <<"username">>) of
        B when is_binary(B) -> B;
        A when is_atom(A) -> atom_to_binary(A, utf8);
        _ -> <<"username">>
    end.

clientid_separator() -> get_cfg(customer_resolver_clientid_separator, <<"_">>).
jwt_claim()          -> get_cfg(customer_resolver_jwt_claim, <<"sub">>).
http_resolver_url()  -> get_cfg(customer_resolver_http_url, <<>>).

tenant_id_bin() ->
    case get_cfg(tenant_id, <<"tenant_default">>) of
        B when is_binary(B) -> B;
        Other -> safe_bin(Other)
    end.

api_key_bin() ->
    case get_cfg(api_key, <<>>) of
        B when is_binary(B) -> B;
        Other -> safe_bin(Other)
    end.

get_cfg(Key, Default) ->
    try emqx_conf:get([aforo_metering, Key], Default) catch _:_ -> Default end.
