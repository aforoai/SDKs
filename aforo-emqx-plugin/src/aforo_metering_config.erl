%%%-------------------------------------------------------------------
%%% @doc
%%% Configuration for the Aforo MQTT Metering plugin.
%%%
%%% Where the values come from: EMQX keeps a plugin's configuration
%%% outside its own config tree, in `$EMQX_DATA_DIR/plugins/<name>/
%%% config.hocon' (copied from the package's `priv/config.hocon' at
%%% install, then changed through the Dashboard or
%%% `PUT /api/v5/plugins/<name-vsn>/config'). It is read with
%%% `emqx_plugin_helper:get_config(<<"aforo_metering-<vsn>">>)', which
%%% wraps `emqx_plugins:get_config/1' and hides its return-shape change
%%% at EMQX 5.9 (`{ok, Map}' before, `Map' after). It is NOT under
%%% `emqx_conf' -- 2.0.0 read `emqx_conf:get([aforo_metering, Key])',
%%% which never held these keys, so every setting silently fell back to
%%% its default.
%%%
%%% The values are kept in one snapshot (persistent_term, atom keys):
%%%   * `load/0' fills it at plugin start;
%%%   * `on_config_changed' (aforo_metering:on_config_changed/2) replaces
%%%     it after the new config passed `validate/1';
%%%   * tests set it with `set_overrides/1'.
%%% Every key the plugin reads goes through this module, so the defaults
%%% live in one table (`spec/0', checked against priv/config.hocon and
%%% priv/config_schema.avsc by aforo_metering_config_tests).
%%%
%%% `validate/0' refuses to start the plugin on a setting that would bill
%%% the wrong customer or the wrong tenant, or send the API key over an
%%% unverified connection: a client-chosen identity source without the
%%% explicit opt-in, a missing or placeholder tenant / product / API key,
%%% or a non-https ingestor URL for a non-local host.
%%% @end
%%%-------------------------------------------------------------------
-module(aforo_metering_config).

-export([
    get/2,
    load/0,
    name_vsn/0,
    normalize/1,
    snapshot/0,
    put_snapshot/1,
    spec/0,
    validate/0,
    validate/1,
    validate_static/0,
    check_environment/0,
    redacted/1,
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
    http_resolver_url/0, http_resolver_authorization/0,
    http_resolver_timeout_ms/0, http_resolver_workers/0,
    http_resolver_queue_size/0, negative_ttl_ms/0, pending_max_ms/0
]).

-define(APP, aforo_metering).
-define(SNAPSHOT, {?MODULE, snapshot}).
%% A candidate config under validation (process dictionary of the caller).
-define(CANDIDATE, {?MODULE, candidate}).
%% Used only when the application spec is not loaded (never inside EMQX).
-define(FALLBACK_VSN, "2.0.3").

%% Values shipped in earlier versions' sample configs. A plugin running on
%% them would bill a tenant that does not exist.
-define(PLACEHOLDER_TENANTS, [<<"tenant_default">>, <<"tenant_acme">>]).
-define(PLACEHOLDER_PRODUCTS, [<<"prod_mqtt_default">>]).
-define(PLACEHOLDER_KEYS, [<<"sk_live_...">>, <<"changeme">>, <<"your-api-key">>]).

%% Backends whose answer the connecting client chooses. They need
%% `unsafe_trust_client_identity = true'. `http' is the operator's own
%% resolver (the SDKs' customerResolver): it receives the verified
%% clientAttrs as well as the client-sent clientId/username, and which
%% one it maps from is the operator's code -- so it is not gated here.
-define(UNSAFE_BACKENDS, [<<"username">>, <<"clientid_prefix">>, <<"jwt_unverified">>]).
-define(SAFE_BACKENDS, [<<"client_attrs">>, <<"http">>]).

%%--------------------------------------------------------------------
%% Spec: every setting, its type and its default
%%--------------------------------------------------------------------

%% {Key, Type, Default}. The defaults equal priv/config.hocon and the
%% `default' of each field in priv/config_schema.avsc (fields without a
%% default there are required and listed with `required' here).
-spec spec() -> [{atom(), string | int | boolean | {array, string}, term()}].
spec() ->
    [
        {tenant_id,                              string,  required},
        {product_id,                             string,  required},
        {api_key,                                string,  required},
        {ingestor_url,                           string,  required},
        {ca_cert_file,                           string,  <<>>},
        {allow_insecure_http,                    boolean, false},
        {aggregation_window_seconds,             int,     60},
        {aggregate_by_topic,                     boolean, false},
        {max_aggregation_keys,                   int,     100000},
        {flush_count,                            int,     500},
        {flush_interval_ms,                      int,     3000},
        {max_buffer_size,                        int,     50000},
        {request_timeout_ms,                     int,     10000},
        {connect_timeout_ms,                     int,     5000},
        {max_retries,                            int,     3},
        {shutdown_timeout_ms,                    int,     5000},
        {emit_deliver,                           boolean, false},
        {exclude_topics,                         {array, string}, [<<"$SYS/#">>, <<"$share/#">>]},
        {customer_resolver,                      string,  <<"client_attrs">>},
        {customer_resolver_client_attr,          string,  <<"aforo_customer_id">>},
        {unsafe_trust_client_identity,           boolean, false},
        {customer_resolver_clientid_separator,   string,  <<"_">>},
        {customer_resolver_jwt_claim,            string,  <<"sub">>},
        {customer_resolver_http_url,             string,  <<>>},
        {customer_resolver_http_authorization,   string,  <<>>},
        {customer_resolver_http_timeout_ms,      int,     1000},
        {customer_resolver_http_workers,         int,     4},
        {customer_resolver_http_queue_size,      int,     10000},
        {customer_resolver_negative_ttl_seconds, int,     30},
        {customer_resolver_pending_max_seconds,  int,     300}
    ].

%% Settings whose value must never appear in a log line.
secret_keys() -> [api_key, customer_resolver_http_authorization].

%%--------------------------------------------------------------------
%% Loading
%%--------------------------------------------------------------------

%% "aforo_metering-2.0.2": the plugin's identity in EMQX.
-spec name_vsn() -> binary().
name_vsn() ->
    Vsn = case application:get_key(?APP, vsn) of
        {ok, V} -> V;
        undefined -> ?FALLBACK_VSN
    end,
    iolist_to_binary([atom_to_list(?APP), "-", Vsn]).

%% Read the plugin config from EMQX into the snapshot. Never throws: if
%% EMQX cannot hand the config back, the snapshot is left empty, which
%% `validate/0' then refuses (no tenant, no API key) with a clear log --
%% the plugin never starts on silent defaults.
-spec load() -> ok.
load() ->
    Raw = try emqx_plugin_helper:get_config(name_vsn()) of
        M when is_map(M) -> M;
        Other ->
            log(error, #{msg => "aforo_metering could not read its plugin config",
                         name_vsn => name_vsn(), returned => Other}),
            #{}
    catch C:R ->
        log(error, #{msg => "aforo_metering could not read its plugin config",
                     name_vsn => name_vsn(), class => C, reason => R}),
        #{}
    end,
    put_snapshot(normalize(Raw)).

%% EMQX hands the config over as a map with binary keys (HOCON / Avro
%% JSON). Only known keys are kept (no atoms are created from input);
%% unknown keys go under '$unknown' so validate/1 can name them, and a
%% 2.0.0-style `aforo_metering { ... }' wrapper is flagged.
-spec normalize(map()) -> map().
normalize(Raw) when is_map(Raw) ->
    Known = [K || {K, _, _} <- spec()],
    KnownBin = [{atom_to_binary(K, utf8), K} || K <- Known],
    maps:fold(
        fun(K, V, Acc) ->
            KB = key_bin(K),
            case lists:keyfind(KB, 1, KnownBin) of
                {_, A} -> Acc#{A => V};
                false when KB =:= <<"aforo_metering">> -> Acc#{'$wrapped' => true};
                false ->
                    Unknown = maps:get('$unknown', Acc, []),
                    Acc#{'$unknown' => [KB | Unknown]}
            end
        end, #{}, Raw);
normalize(_) -> #{}.

key_bin(K) when is_atom(K) -> atom_to_binary(K, utf8);
key_bin(K) when is_binary(K) -> K;
key_bin(K) when is_list(K) -> unicode:characters_to_binary(K);
key_bin(_) -> <<>>.

-spec snapshot() -> map().
snapshot() -> persistent_term:get(?SNAPSHOT, #{}).

-spec put_snapshot(map()) -> ok.
put_snapshot(Map) when is_map(Map) ->
    persistent_term:put(?SNAPSHOT, Map), ok.

%% Test hook: replace the snapshot with Map (atom or binary keys).
-spec set_overrides(map()) -> ok.
set_overrides(Map) when is_map(Map) ->
    put_snapshot(normalize(Map)).

-spec clear_overrides() -> ok.
clear_overrides() ->
    _ = persistent_term:erase(?SNAPSHOT), ok.

%%--------------------------------------------------------------------
%% Raw access
%%--------------------------------------------------------------------

-spec get(atom(), term()) -> term().
get(Key, Default) ->
    Conf = case erlang:get(?CANDIDATE) of
        undefined -> snapshot();
        C -> C
    end,
    case maps:find(Key, Conf) of
        {ok, null} -> Default;
        {ok, V} -> V;
        error -> Default
    end.

%%--------------------------------------------------------------------
%% Typed accessors
%%--------------------------------------------------------------------

tenant_id()   -> trim(bin(get(tenant_id, <<>>))).
product_id()  -> trim(bin(get(product_id, <<>>))).
api_key()     -> trim(bin(get(api_key, <<>>))).
ingestor_url() -> trim(bin(get(ingestor_url, <<>>))).

%% Clamped to the ingestor's 1000-event batch limit.
flush_count()       -> clamp(int(get(flush_count, 500), 500), 1, 1000).
flush_interval_ms() -> clamp(int(get(flush_interval_ms, 3000), 3000), 100, 600000).
max_buffer_size()   -> clamp(int(get(max_buffer_size, 50000), 50000), 1, 10000000).

request_timeout_ms()  -> clamp(int(get(request_timeout_ms, 10000), 10000), 100, 120000).
connect_timeout_ms()  -> clamp(int(get(connect_timeout_ms, 5000), 5000), 100, 60000).
max_retries()         -> clamp(int(get(max_retries, 3), 3), 0, 10).
shutdown_timeout_ms() -> clamp(int(get(shutdown_timeout_ms, 5000), 5000), 0, 60000).
allow_insecure_http() -> bool(get(allow_insecure_http, false)).
ca_cert_file()        -> trim(bin(get(ca_cert_file, <<>>))).

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

customer_resolver() -> trim(bin(get(customer_resolver, <<"client_attrs">>))).
unsafe_trust_client_identity() -> bool(get(unsafe_trust_client_identity, false)).
client_attr()        -> bin(get(customer_resolver_client_attr, <<"aforo_customer_id">>)).
clientid_separator() -> bin(get(customer_resolver_clientid_separator, <<"_">>)).
jwt_claim()          -> bin(get(customer_resolver_jwt_claim, <<"sub">>)).

http_resolver_url()        -> trim(bin(get(customer_resolver_http_url, <<>>))).
http_resolver_authorization() -> bin(get(customer_resolver_http_authorization, <<>>)).
http_resolver_timeout_ms() -> clamp(int(get(customer_resolver_http_timeout_ms, 1000), 1000), 50, 10000).
http_resolver_workers()    -> clamp(int(get(customer_resolver_http_workers, 4), 4), 1, 64).
http_resolver_queue_size() -> clamp(int(get(customer_resolver_http_queue_size, 10000), 10000), 1, 1000000).
negative_ttl_ms() ->
    clamp(int(get(customer_resolver_negative_ttl_seconds, 30), 30), 1, 86400) * 1000.
pending_max_ms() ->
    clamp(int(get(customer_resolver_pending_max_seconds, 300), 300), 1, 86400) * 1000.

%%--------------------------------------------------------------------
%% Validation
%%--------------------------------------------------------------------

%% At plugin start (aforo_metering:prepare/0): everything, including the
%% checks that depend on this node (CA bundle on disk / in the OS).
-spec validate() -> ok | {error, [binary()]}.
validate() ->
    result(static_errors() ++ environment_errors()).

%% A candidate config (normalized map) from on_config_changed. Only the
%% checks that give the same answer on every node: EMQX calls the
%% callback on each node of the cluster and a check that passes on some
%% nodes but not others would split the cluster's config. Node-local
%% problems (a missing CA file) are reported by on_health_check instead,
%% and fail the next start on that node.
-spec validate(map()) -> ok | {error, [binary()]}.
validate(Candidate) when is_map(Candidate) ->
    Prev = erlang:put(?CANDIDATE, Candidate),
    try result(static_errors())
    after restore_candidate(Prev)
    end.

-spec validate_static() -> ok | {error, [binary()]}.
validate_static() -> result(static_errors()).

%% Node-local checks only (on_health_check).
-spec check_environment() -> ok | {error, [binary()]}.
check_environment() -> result(environment_errors()).

restore_candidate(undefined) -> erlang:erase(?CANDIDATE);
restore_candidate(Prev) -> erlang:put(?CANDIDATE, Prev).

result([]) -> ok;
result(Errors) -> {error, Errors}.

static_errors() ->
    Conf = case erlang:get(?CANDIDATE) of
        undefined -> snapshot();
        C -> C
    end,
    warn_unknown(maps:get('$unknown', Conf, [])),
    lists:flatten([
        case maps:get('$wrapped', Conf, false) of
            true ->
                [<<"the config is nested under `aforo_metering { ... }` (the 2.0.0 layout); "
                   "since 2.0.1 the settings are top-level keys of the plugin config">>];
            false -> []
        end,
        validate_identity(),
        validate_resolver(),
        case ingestor_url() of
            <<>> -> [<<"ingestor_url is not set">>];
            Url -> validate_url(ingestor_url, Url)
        end,
        case customer_resolver() of
            <<"http">> ->
                case http_resolver_url() of
                    <<>> -> [<<"customer_resolver = \"http\" needs customer_resolver_http_url">>];
                    U -> validate_url(customer_resolver_http_url, U)
                end;
            _ -> []
        end
    ]).

environment_errors() ->
    case uses_https() of
        true -> validate_ca_source();
        false -> []
    end.

%% Refuse to run on settings that would send usage for a tenant, product
%% or key that is not the operator's.
validate_identity() ->
    lists:flatten([
        required(tenant_id, tenant_id(), ?PLACEHOLDER_TENANTS,
                 <<"the Aforo tenant id (X-Tenant-Id)">>),
        required(product_id, product_id(), ?PLACEHOLDER_PRODUCTS,
                 <<"the Aforo product id of this broker">>),
        validate_api_key(api_key())
    ]).

required(Key, <<>>, _Placeholders, What) ->
    [<<(atom_to_binary(Key, utf8))/binary, " is not set; set it to ", What/binary>>];
required(Key, Value, Placeholders, What) ->
    case lists:member(Value, Placeholders) orelse is_unresolved(Value) of
        true ->
            [<<(atom_to_binary(Key, utf8))/binary, " is the placeholder \"", Value/binary,
               "\"; set it to ", What/binary>>];
        false -> []
    end.

validate_api_key(<<>>) ->
    [<<"api_key is not set; set it to an Aforo API key with scope usage:ingest">>];
validate_api_key(Key) ->
    case is_unresolved(Key) of
        true ->
            [<<"api_key holds an unresolved placeholder (\"${...}\"); EMQX does not substitute ",
               "environment variables in plugin config -- set the key itself through the ",
               "Dashboard or PUT /api/v5/plugins/{name-vsn}/config">>];
        false ->
            case lists:member(Key, ?PLACEHOLDER_KEYS) of
                true -> [<<"api_key is a placeholder; set it to an Aforo API key">>];
                false -> []
            end
    end.

is_unresolved(V) -> binary:match(V, <<"${">>) =/= nomatch.

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
    case is_unresolved(Url) of
        true -> [<<KeyBin/binary, " holds an unresolved placeholder (\"${...}\")">>];
        false -> validate_url_parsed(KeyBin, Url)
    end.

validate_url_parsed(KeyBin, Url) ->
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

%% A misspelt key would otherwise be ignored without a word.
warn_unknown([]) -> ok;
warn_unknown(Keys) ->
    log(warning, #{msg => "aforo_metering ignores unknown config keys", keys => lists:sort(Keys)}).

%%--------------------------------------------------------------------
%% Logging helpers
%%--------------------------------------------------------------------

%% The config for a log line: secrets replaced by whether they are set.
-spec redacted(map()) -> map().
redacted(Conf) ->
    maps:map(
        fun(K, V) ->
            case lists:member(K, secret_keys()) of
                true when V =:= <<>>; V =:= ""; V =:= null -> <<"(not set)">>;
                true -> <<"******">>;
                false -> V
            end
        end, maps:without(['$unknown', '$wrapped'], Conf)).

log(Level, Data) -> logger:log(Level, Data).

%%--------------------------------------------------------------------
%% Coercion (EMQX hands back binaries; tests may use strings or atoms)
%%--------------------------------------------------------------------

bin(B) when is_binary(B) -> B;
bin(L) when is_list(L) ->
    case unicode:characters_to_binary(L) of
        B when is_binary(B) -> B;
        _ -> <<>>
    end;
bin(A) when is_atom(A), A =/= null, A =/= undefined -> atom_to_binary(A, utf8);
bin(I) when is_integer(I) -> integer_to_binary(I);
bin(_) -> <<>>.

trim(B) -> string:trim(B).

int(I, _) when is_integer(I) -> I;
int(B, D) when is_binary(B) ->
    try binary_to_integer(string:trim(B)) catch _:_ -> D end;
int(L, D) when is_list(L) -> int(bin(L), D);
int(_, D) -> D.

bool(true) -> true;
bool(<<"true">>) -> true;
bool("true") -> true;
bool(_) -> false.

clamp(V, Min, _Max) when V < Min -> Min;
clamp(V, _Min, Max) when V > Max -> Max;
clamp(V, _, _) -> V.
