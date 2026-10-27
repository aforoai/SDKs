%%%-------------------------------------------------------------------
%%% @doc
%%% Configuration for the Aforo MQTT Metering plugin.
%%%
%%% Every config key the plugin reads goes through this module, so the
%%% defaults live in one place and `validate/0' can refuse to start the
%%% plugin on a setting that would bill the wrong customer (an
%%% identity source the client controls, without the explicit opt-in) or
%%% send the API key over an unverified connection.
%%%
%%% Values come from `emqx_conf' under `aforo_metering'. In tests the
%%% overrides set with `set_overrides/1' win, so suites never need an
%%% EMQX node.
%%% @end
%%%-------------------------------------------------------------------
-module(aforo_metering_config).

-export([
    get/2,
    validate/0,
    set_overrides/1,
    clear_overrides/0,
    %% typed accessors
    tenant_id/0, product_id/0, api_key/0, ingestor_url/0,
    flush_count/0, flush_interval_ms/0, max_buffer_size/0,
    request_timeout_ms/0, connect_timeout_ms/0, max_retries/0,
    shutdown_timeout_ms/0, allow_insecure_http/0, ca_cert_file/0,
    emit_deliver/0, exclude_topics/0,
    aggregation_window_ms/0, aggregate_by_topic/0, max_aggregation_keys/0,
    customer_resolver/0, unsafe_trust_client_identity/0,
    client_attr/0, clientid_separator/0, jwt_claim/0,
    http_resolver_url/0, http_resolver_timeout_ms/0, http_resolver_workers/0,
    http_resolver_queue_size/0, negative_ttl_ms/0, pending_max_ms/0
]).

-define(OVERRIDES, {?MODULE, overrides}).

%% Backends whose answer the connecting client chooses. They need
%% `unsafe_trust_client_identity = true'.
-define(UNSAFE_BACKENDS, [<<"username">>, <<"clientid_prefix">>, <<"jwt_unverified">>]).
-define(SAFE_BACKENDS, [<<"client_attrs">>, <<"http">>]).

%%--------------------------------------------------------------------
%% Raw access
%%--------------------------------------------------------------------

-spec get(atom(), term()) -> term().
get(Key, Default) ->
    Overrides = persistent_term:get(?OVERRIDES, #{}),
    case maps:find(Key, Overrides) of
        {ok, V} -> V;
        error ->
            try emqx_conf:get([aforo_metering, Key], Default)
            catch _:_ -> Default
            end
    end.

%% Test hook: values here win over emqx_conf.
-spec set_overrides(map()) -> ok.
set_overrides(Map) when is_map(Map) ->
    persistent_term:put(?OVERRIDES, Map), ok.

-spec clear_overrides() -> ok.
clear_overrides() ->
    _ = persistent_term:erase(?OVERRIDES), ok.

%%--------------------------------------------------------------------
%% Typed accessors
%%--------------------------------------------------------------------

tenant_id()   -> bin(get(tenant_id, <<"tenant_default">>)).
product_id()  -> bin(get(product_id, <<"prod_mqtt_default">>)).
api_key()     -> bin(get(api_key, <<>>)).
ingestor_url() -> bin(get(ingestor_url, <<"https://api.aforo.ai/v1/ingest/batch">>)).

%% Clamped to the ingestor's 1000-event batch limit.
flush_count()       -> clamp(int(get(flush_count, 500), 500), 1, 1000).
flush_interval_ms() -> clamp(int(get(flush_interval_ms, 3000), 3000), 100, 600000).
max_buffer_size()   -> clamp(int(get(max_buffer_size, 50000), 50000), 1, 10000000).

request_timeout_ms()  -> clamp(int(get(request_timeout_ms, 10000), 10000), 100, 120000).
connect_timeout_ms()  -> clamp(int(get(connect_timeout_ms, 5000), 5000), 100, 60000).
max_retries()         -> clamp(int(get(max_retries, 3), 3), 0, 10).
shutdown_timeout_ms() -> clamp(int(get(shutdown_timeout_ms, 5000), 5000), 0, 60000).
allow_insecure_http() -> bool(get(allow_insecure_http, false)).
ca_cert_file()        -> bin(get(ca_cert_file, <<>>)).

emit_deliver() -> bool(get(emit_deliver, false)).

%% MQTT topic filters ("+" one level, "#" the rest) for topics not metered.
exclude_topics() ->
    case get(exclude_topics, [<<"$SYS/#">>, <<"$share/#">>]) of
        L when is_list(L) ->
            %% a string (list of integers) would be one filter, not many
            case io_lib:printable_unicode_list(L) andalso L =/= [] of
                true -> [bin(L)];
                false -> [bin(F) || F <- L, bin(F) =/= <<>>]
            end;
        B when is_binary(B) -> [B];
        _ -> []
    end.

%% 0 = one event per broker event (no aggregation).
aggregation_window_ms() ->
    clamp(int(get(aggregation_window_seconds, 60), 60), 0, 3600) * 1000.
aggregate_by_topic()    -> bool(get(aggregate_by_topic, false)).
max_aggregation_keys()  -> clamp(int(get(max_aggregation_keys, 100000), 100000), 1, 10000000).

customer_resolver() -> bin(get(customer_resolver, <<"client_attrs">>)).
unsafe_trust_client_identity() -> bool(get(unsafe_trust_client_identity, false)).
client_attr()        -> bin(get(customer_resolver_client_attr, <<"aforo_customer_id">>)).
clientid_separator() -> bin(get(customer_resolver_clientid_separator, <<"_">>)).
jwt_claim()          -> bin(get(customer_resolver_jwt_claim, <<"sub">>)).

http_resolver_url()        -> bin(get(customer_resolver_http_url, <<>>)).
http_resolver_timeout_ms() -> clamp(int(get(customer_resolver_http_timeout_ms, 1000), 1000), 50, 10000).
http_resolver_workers()    -> clamp(int(get(customer_resolver_http_workers, 4), 4), 1, 64).
http_resolver_queue_size() -> clamp(int(get(customer_resolver_http_queue_size, 10000), 10000), 1, 1000000).
negative_ttl_ms() ->
    clamp(int(get(customer_resolver_negative_ttl_seconds, 30), 30), 1, 86400) * 1000.
pending_max_ms() ->
    clamp(int(get(customer_resolver_pending_max_seconds, 300), 300), 1, 86400) * 1000.

%%--------------------------------------------------------------------
%% Validation (called by aforo_metering:load/0; a failure stops the load)
%%--------------------------------------------------------------------

-spec validate() -> ok | {error, [binary()]}.
validate() ->
    Errors = lists:flatten([
        validate_resolver(),
        validate_url(ingestor_url, ingestor_url()),
        case customer_resolver() of
            <<"http">> ->
                case http_resolver_url() of
                    <<>> -> [<<"customer_resolver = \"http\" needs customer_resolver_http_url">>];
                    U -> validate_url(customer_resolver_http_url, U)
                end;
            _ -> []
        end,
        case uses_https() of
            true -> validate_ca_source();
            false -> []
        end
    ]),
    case Errors of
        [] -> ok;
        _ -> {error, Errors}
    end.

validate_resolver() ->
    B = customer_resolver(),
    case {lists:member(B, ?SAFE_BACKENDS), lists:member(B, ?UNSAFE_BACKENDS)} of
        {true, _} -> [];
        {_, true} ->
            case unsafe_trust_client_identity() of
                true -> [];
                false ->
                    [<<"customer_resolver = \"", B/binary, "\" bills a value the MQTT client chooses ",
                       "(a client could bill its traffic to another customer). Use \"client_attrs\" ",
                       "(set by EMQX authentication) or \"http\", or set ",
                       "unsafe_trust_client_identity = true if your broker authentication pins this value.">>]
            end;
        _ when B =:= <<"jwt">> ->
            [<<"customer_resolver = \"jwt\" was removed in 2.0.0: it decoded the token without checking ",
               "its signature. Configure EMQX JWT authentication with a client_attrs claim and use ",
               "customer_resolver = \"client_attrs\" (or \"jwt_unverified\" with ",
               "unsafe_trust_client_identity = true).">>];
        _ ->
            [<<"unknown customer_resolver \"", B/binary, "\"; use client_attrs, http, username, ",
               "clientid_prefix or jwt_unverified">>]
    end.

uses_https() ->
    Urls = [ingestor_url() | case customer_resolver() of
                                 <<"http">> -> [http_resolver_url()];
                                 _ -> []
                             end],
    lists:any(fun(U) -> string:prefix(string:lowercase(U), <<"https:">>) =/= nomatch end, Urls).

%% https always. http only for a loopback host, or with allow_insecure_http.
validate_url(Key, Url) ->
    KeyBin = atom_to_binary(Key, utf8),
    case uri_string:parse(Url) of
        #{scheme := Scheme, host := Host} when Host =/= <<>>, Host =/= "" ->
            case string:lowercase(bin(Scheme)) of
                <<"https">> -> [];
                <<"http">> ->
                    case is_loopback(bin(Host)) orelse allow_insecure_http() of
                        true -> [];
                        false ->
                            [<<KeyBin/binary, " uses http:// for a non-local host; the API key would ",
                               "travel unencrypted. Use https://, or set allow_insecure_http = true.">>]
                    end;
                Other ->
                    [<<KeyBin/binary, " has unsupported scheme \"", Other/binary, "\"">>]
            end;
        _ ->
            [<<KeyBin/binary, " is not a valid URL">>]
    end.

is_loopback(<<"localhost">>) -> true;
is_loopback(<<"127.0.0.1">>) -> true;
is_loopback(<<"::1">>) -> true;
is_loopback(<<"[::1]">>) -> true;
is_loopback(_) -> false.

validate_ca_source() ->
    case ca_cert_file() of
        <<>> ->
            case aforo_metering_http:system_cacerts() of
                {ok, _} -> [];
                {error, _} ->
                    [<<"no system CA certificates available (public_key:cacerts_get/0 failed); ",
                       "set ca_cert_file">>]
            end;
        File ->
            case filelib:is_regular(binary_to_list(File)) of
                true -> [];
                false -> [<<"ca_cert_file \"", File/binary, "\" does not exist">>]
            end
    end.

%%--------------------------------------------------------------------
%% Coercion (emqx_conf may hand back binaries, strings or atoms)
%%--------------------------------------------------------------------

bin(B) when is_binary(B) -> B;
bin(L) when is_list(L) -> unicode:characters_to_binary(L);
bin(A) when is_atom(A) -> atom_to_binary(A, utf8);
bin(I) when is_integer(I) -> integer_to_binary(I);
bin(_) -> <<>>.

int(I, _) when is_integer(I) -> I;
int(B, D) when is_binary(B) ->
    try binary_to_integer(string:trim(B)) catch _:_ -> D end;
int(L, D) when is_list(L) -> int(list_to_binary(L), D);
int(_, D) -> D.

bool(true) -> true;
bool(<<"true">>) -> true;
bool("true") -> true;
bool(_) -> false.

clamp(V, Min, _Max) when V < Min -> Min;
clamp(V, _Min, Max) when V > Max -> Max;
clamp(V, _, _) -> V.
