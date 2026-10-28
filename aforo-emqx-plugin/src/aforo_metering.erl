%%%-------------------------------------------------------------------
%%% @doc
%%% Aforo MQTT Metering Plugin for EMQX 5.x
%%%
%%% Registers hooks on connect / disconnect / publish / deliver /
%%% subscribe / unsubscribe. Each hook resolves the customer (from the
%%% identity EMQX authentication established, by default) and bumps a
%%% per-window counter; aforo_metering_flusher turns closed windows into
%%% usage events and sends them to the Aforo ingestor.
%%%
%%% Hooks never send, never block on the network and never touch the
%%% outgoing queue. A hook that fails is caught so metering can never
%%% break message delivery.
%%% @end
%%%-------------------------------------------------------------------
-module(aforo_metering).

-include("aforo_metering_emqx.hrl").

-export([
    prepare/0,
    load/0,
    unload/0,
    cleanup/0,
    health/0,
    flush_now/0,
    on_config_changed/2,
    on_health_check/1,
    %% Hook callbacks
    on_client_connected/3,
    on_client_disconnected/4,
    on_message_publish/2,
    on_message_delivered/3,
    on_session_subscribed/4,
    on_session_unsubscribed/4
]).

-ifdef(TEST).
-export([bad_keys/1, rejects_on_error/0, parse_vsn/1]).
-endif.

-define(VERSION, <<"2.0.3">>).

%%--------------------------------------------------------------------
%% Lifecycle (aforo_metering_app)
%%--------------------------------------------------------------------

%% Before the supervision tree starts: refuse a bad configuration.
-spec prepare() -> ok | {error, term()}.
prepare() ->
    case aforo_metering_config:validate() of
        ok ->
            clear_config_problem(),
            ok = aforo_metering_http:start_profile(),
            ok = aforo_metering_metrics:init(),
            aforo_metering_metrics:set_circuit_state(closed),
            ok;
        {error, Reasons} ->
            [?SLOG(error, #{msg => "aforo_metering refused to start: invalid configuration",
                            reason => R}) || R <- Reasons],
            {error, {invalid_config, Reasons}}
    end.

load() ->
    emqx_hooks:add('client.connected',     {?MODULE, on_client_connected, [#{}]},     ?HP_LOWEST),
    emqx_hooks:add('client.disconnected',  {?MODULE, on_client_disconnected, [#{}]},  ?HP_LOWEST),
    emqx_hooks:add('message.publish',      {?MODULE, on_message_publish, [#{}]},      ?HP_LOWEST),
    emqx_hooks:add('message.delivered',    {?MODULE, on_message_delivered, [#{}]},    ?HP_LOWEST),
    emqx_hooks:add('session.subscribed',   {?MODULE, on_session_subscribed, [#{}]},   ?HP_LOWEST),
    emqx_hooks:add('session.unsubscribed', {?MODULE, on_session_unsubscribed, [#{}]}, ?HP_LOWEST),
    ?SLOG(info, #{
        msg => "aforo_metering plugin loaded",
        version => ?VERSION,
        tenant_id => aforo_metering_config:tenant_id(),
        product_id => aforo_metering_config:product_id(),
        customer_resolver => aforo_metering_config:customer_resolver(),
        aggregation_window_ms => aforo_metering_config:aggregation_window_ms(),
        aggregate_by_topic => aforo_metering_config:aggregate_by_topic(),
        flush_count => aforo_metering_config:flush_count(),
        flush_interval_ms => aforo_metering_config:flush_interval_ms(),
        max_buffer_size => aforo_metering_config:max_buffer_size(),
        config => aforo_metering_config:redacted(aforo_metering_config:snapshot())
    }),
    ok.

%% Stop accepting events, then send what is left within
%% shutdown_timeout_ms (open windows included).
unload() ->
    emqx_hooks:del('client.connected',     {?MODULE, on_client_connected}),
    emqx_hooks:del('client.disconnected',  {?MODULE, on_client_disconnected}),
    emqx_hooks:del('message.publish',      {?MODULE, on_message_publish}),
    emqx_hooks:del('message.delivered',    {?MODULE, on_message_delivered}),
    emqx_hooks:del('session.subscribed',   {?MODULE, on_session_subscribed}),
    emqx_hooks:del('session.unsubscribed', {?MODULE, on_session_unsubscribed}),
    Result = try aforo_metering_flusher:drain(aforo_metering_config:shutdown_timeout_ms())
             catch C:R -> {error, {C, R}}
             end,
    ?SLOG(info, #{msg => "aforo_metering plugin unloaded", drain => Result}),
    ok.

cleanup() ->
    aforo_metering_aggregator:delete(),
    aforo_metering_http:stop_profile().

-spec health() -> map().
health() ->
    Status = try aforo_metering_flusher:status() catch _:_ -> #{} end,
    #{
        plugin          => <<"aforo_metering">>,
        version         => ?VERSION,
        tenant_id       => aforo_metering_config:tenant_id(),
        product_id      => aforo_metering_config:product_id(),
        ingestor_url    => aforo_metering_config:ingestor_url(),
        buffer_depth    => maps:get(queue_depth, Status, 0),
        max_buffer_size => aforo_metering_config:max_buffer_size(),
        open_aggregation_keys => aforo_metering_aggregator:open_keys(),
        cache_size      => aforo_metering_cache:size(),
        circuit_state   => atom_to_binary(maps:get(circuit, Status, closed), utf8),
        config_problem  => case config_problem() of undefined -> null; P -> P end,
        counters        => maps:from_list(aforo_metering_metrics:get_all())
    }.

%% Close finished windows and send now.
-spec flush_now() -> ok.
flush_now() ->
    aforo_metering_flusher:flush().

%%--------------------------------------------------------------------
%% EMQX plugin callbacks (called through aforo_metering_app)
%%--------------------------------------------------------------------

%% EMQX 5.8+ calls this on every node when the plugin config is changed
%% through the Dashboard or `PUT /api/v5/plugins/{name-vsn}/config',
%% also while the plugin is installed but stopped. (5.7 has no callback:
%% restart the plugin after a change.)
%%
%% What EMQX does with the return value differs by version:
%%   * 5.9+: `{error, Reason}' rejects the change -- it is not saved and
%%     the caller gets the reason. An accepted change is applied here
%%     BEFORE EMQX saves it; if the save then fails, the running plugin
%%     has the new config until the next restart, which reads the saved
%%     (old) one.
%%   * 5.8: the return value is ignored and the change is saved anyway.
%%     A refused change is therefore logged at error level, naming the
%%     keys, the gauge `aforo.metering.config.invalid' is set to 1 and
%%     health/0 reports it: the next start will fail until it is fixed.
%%     The running plugin keeps its config -- an invalid config is never
%%     applied.
%% EMQX's version is read from the `emqx' application; an unknown
%% version is treated like 5.8 (see rejects_on_error/0).
%%
%% NewConfig has already passed priv/config_schema.avsc. Checks here are
%% the same on every node (no file or network checks -- see
%% aforo_metering_config:validate/1); node-local problems show in
%% on_health_check/1. EMQX calls this on each node separately and does
%% not roll the other nodes back when one refuses or fails, so on a 5.9
%% cluster nodes can end up running different configs; check every
%% node's log after a change.
%%
%% While running, the change is applied in place, nothing queued is
%% dropped:
%%   * delivery settings (URL, key, CA, timeouts, retries) take effect
%%     on the next request, and a paused delivery is retried at once; a
%%     change of URL, CA or allow_insecure_http also moves new requests
%%     to fresh connections (aforo_metering_http:reset_connections/0);
%%   * flush_count / flush_interval_ms / max_buffer_size and the
%%     aggregation settings are applied inside the flusher between
%%     ticks; a new window length or topic dimension closes the open
%%     windows at once (sent as partial windows);
%%   * the http resolver pool takes the new worker and queue sizes;
%%     customers already resolved stay cached until their connection
%%     ends, so publishers stay attributed.
%% tenant_id and product_id cannot change while running: usage already
%% counted belongs to the old ones. On 5.9+ a change of either is
%% rejected as a whole. On 5.8 (which saves it anyway) every other key
%% of the change is applied, the running plugin keeps its tenant and
%% product, and the error log says the new ones take effect at the next
%% stop/start -- so later changes keep applying instead of being
%% refused until a restart.
-spec on_config_changed(map(), map()) -> ok | {error, binary()}.
on_config_changed(_OldConfig, NewConfig) when is_map(NewConfig) ->
    Candidate = aforo_metering_config:normalize(NewConfig),
    case aforo_metering_config:validate(Candidate) of
        {error, Reasons} ->
            refuse_invalid(Reasons),
            {error, join(Reasons)};
        ok ->
            clear_config_problem(),
            case is_running() of
                false ->
                    ok = aforo_metering_config:put_snapshot(Candidate),
                    ?SLOG(info, #{msg => "aforo_metering config stored; applied when the plugin starts"}),
                    ok;
                true ->
                    apply_running(Candidate)
            end
    end;
on_config_changed(_OldConfig, _NewConfig) ->
    {error, <<"the plugin config must be a map">>}.

refuse_invalid(Reasons) ->
    Keys = bad_keys(Reasons),
    case rejects_on_error() of
        true ->
            ?SLOG(error, #{msg => "aforo_metering rejected a config change; EMQX does not save it",
                           keys => Keys, reasons => Reasons});
        false ->
            Problem = iolist_to_binary(
                ["EMQX saved a config change the plugin refused (keys: ",
                 lists:join(<<", ">>, [atom_to_binary(K, utf8) || K <- Keys]),
                 "); the plugin keeps running on its current config, but its next start ",
                 "will fail until the config is fixed: ", join(Reasons)]),
            set_config_problem(Problem),
            ?SLOG(error, #{msg => "aforo_metering refused a config change that EMQX saved anyway "
                                  "(EMQX 5.8 ignores the refusal). The running plugin keeps its "
                                  "current config; the NEXT START WILL FAIL until these keys are fixed",
                           keys => Keys, reasons => Reasons})
    end.

%% The setting each refusal is about -- the first setting name it
%% mentions as a whole word ("ingestor_url uses http:// ... or set
%% allow_insecure_http = true" is about ingestor_url) -- for the log.
-spec bad_keys([binary()]) -> [atom()].
bad_keys(Reasons) ->
    Names = [{K, atom_to_binary(K, utf8)} || {K, _, _} <- aforo_metering_config:spec()],
    Keys = lists:foldl(
        fun(Reason, Acc) ->
            Hits = lists:sort([{Pos, K} || {K, W} <- Names, Pos <- word_positions(Reason, W)]),
            case Hits of
                [{_, K} | _] -> case lists:member(K, Acc) of true -> Acc; false -> Acc ++ [K] end;
                [] -> Acc
            end
        end, [], Reasons),
    case Keys of
        [] -> ['$config'];
        _ -> Keys
    end.

word_positions(Text, Word) ->
    [Pos || {Pos, Len} <- binary:matches(Text, Word),
            not word_char(Text, Pos - 1), not word_char(Text, Pos + Len)].

word_char(Text, I) when I < 0; I >= byte_size(Text) -> false;
word_char(Text, I) ->
    C = binary:at(Text, I),
    (C >= $a andalso C =< $z) orelse (C >= $0 andalso C =< $9) orelse C =:= $_.

apply_running(Candidate0) ->
    Current = aforo_metering_config:snapshot(),
    Identity = [K || K <- [tenant_id, product_id], value(K, Current) =/= value(K, Candidate0)],
    IdentityReason = <<"tenant_id and product_id cannot change while the plugin is running ",
                       "(usage already counted belongs to the current ones); stop the plugin, ",
                       "change them, then start it">>,
    case Identity =/= [] andalso rejects_on_error() of
        true ->
            %% 5.9+: the whole change is rejected and not saved.
            ?SLOG(error, #{msg => "aforo_metering rejected a config change", reason => IdentityReason,
                           keys => Identity}),
            {error, IdentityReason};
        false ->
            %% Keep the running identity; apply everything else.
            Candidate = maps:merge(Candidate0, maps:with([tenant_id, product_id], Current)),
            apply_keys(Current, Candidate),
            case Identity of
                [] -> ok;
                _ ->
                    set_config_problem(iolist_to_binary(
                        ["EMQX saved a new ", lists:join(<<" and ">>, [atom_to_binary(K, utf8) || K <- Identity]),
                         "; the running plugin keeps the current one until it is stopped and started"])),
                    ?SLOG(error, #{msg => "aforo_metering cannot change tenant_id / product_id while "
                                          "running; EMQX saved the change anyway (EMQX 5.8). The other "
                                          "changed keys were applied; usage keeps going to the current "
                                          "tenant and product. Stop and start the plugin to switch.",
                                   keys => Identity,
                                   running => maps:with([tenant_id, product_id], Current)}),
                    {error, IdentityReason}
            end
    end.

apply_keys(Current, Candidate) ->
    Changed = [K || {K, _, _} <- aforo_metering_config:spec(),
                    maps:get(K, Current, undefined) =/= maps:get(K, Candidate, undefined)],
    ok = aforo_metering_config:put_snapshot(Candidate),
    case Changed of
        [] -> ok;
        _ ->
            case lists:any(fun(K) -> lists:member(K, Changed) end, connection_keys()) of
                true ->
                    try aforo_metering_http:reset_connections()
                    catch C0:R0 ->
                        ?SLOG(error, #{msg => "aforo_metering could not reset its HTTP connections; "
                                              "open connections keep the previous TLS settings until "
                                              "they close", class => C0, reason => R0})
                    end;
                false -> ok
            end,
            Shape = try aforo_metering_flusher:reconfigure() of
                        {ok, S} -> S
                    catch C1:R1 ->
                        ?SLOG(error, #{msg => "aforo_metering flusher did not take the new config; "
                                              "it applies when the flusher restarts",
                                       class => C1, reason => R1}),
                        unknown
                    end,
            try aforo_metering_resolver_pool:reconfigure()
            catch C2:R2 ->
                ?SLOG(error, #{msg => "aforo_metering resolver pool did not take the new config; "
                                      "it applies when the pool restarts",
                               class => C2, reason => R2})
            end,
            ?SLOG(info, #{msg => "aforo_metering config applied", changed => Changed,
                          windows => Shape}),
            ok
    end.

%% Settings an open (keep-alive) connection was made under.
connection_keys() ->
    [ingestor_url, ca_cert_file, allow_insecure_http, customer_resolver_http_url].

value(K, Conf) ->
    case maps:get(K, Conf, <<>>) of
        V when is_binary(V) -> string:trim(V);
        V when is_list(V) -> string:trim(unicode:characters_to_binary(V));
        V -> V
    end.

%% True when EMQX honours `{error, _}' from on_config_changed (5.9+).
%% 5.8 (and anything older or unknown) saves the change regardless.
-spec rejects_on_error() -> boolean().
rejects_on_error() ->
    case emqx_version() of
        {Major, Minor} -> {Major, Minor} >= {5, 9};
        unknown -> false
    end.

emqx_version() ->
    %% emqx_release:version() is the broker release (5.9.1); the emqx
    %% application vsn is an internal app version (5.5.x on 5.8/5.9), so it is
    %% only a fallback for brokers without emqx_release.
    Vsn = case (try emqx_release:version() catch _:_ -> undefined end) of
        undefined ->
            case application:get_key(emqx, vsn) of {ok, V} -> V; undefined -> undefined end;
        R -> R
    end,
    parse_vsn(Vsn).

parse_vsn(V) when is_binary(V) -> parse_vsn(binary_to_list(V));
parse_vsn([C | Rest]) when C =:= $e; C =:= $v -> parse_vsn(Rest);
parse_vsn(V) when is_list(V) ->
    case string:split(V, ".", all) of
        [Ma, Mi | _] ->
            try {list_to_integer(Ma), list_to_integer(string:trim(Mi, trailing, "-abcdefghijklmnopqrstuvwxyz"))}
            catch _:_ -> unknown
            end;
        _ -> unknown
    end;
parse_vsn(_) -> unknown.

-define(CONFIG_PROBLEM, {?MODULE, config_problem}).

set_config_problem(Text) ->
    persistent_term:put(?CONFIG_PROBLEM, Text),
    aforo_metering_metrics:set_config_invalid(true).

clear_config_problem() ->
    _ = persistent_term:erase(?CONFIG_PROBLEM),
    aforo_metering_metrics:set_config_invalid(false).

config_problem() -> persistent_term:get(?CONFIG_PROBLEM, undefined).

%% EMQX 5.9+ calls this when the plugin's info is requested.
-spec on_health_check(map()) -> ok | {error, binary()}.
on_health_check(_Options) ->
    case {config_problem(), aforo_metering_config:check_environment()} of
        {Problem, _} when is_binary(Problem) -> {error, Problem};
        {_, {error, Reasons}} -> {error, join(Reasons)};
        {_, ok} ->
            Status = try aforo_metering_flusher:status() catch _:_ -> undefined end,
            case Status of
                undefined -> ok;
                #{circuit := open, consecutive_failures := N, queue_depth := Q} ->
                    {error, iolist_to_binary(io_lib:format(
                        "delivery to the Aforo ingestor is paused after ~b failed sends; "
                        "~b usage events queued", [N, Q]))};
                _ -> ok
            end
    end.

is_running() -> whereis(aforo_metering_flusher) =/= undefined.

join(Reasons) -> iolist_to_binary(lists:join(<<"; ">>, Reasons)).

%%--------------------------------------------------------------------
%% Hook callbacks
%%--------------------------------------------------------------------

on_client_connected(ClientInfo, ConnInfo, _Env) ->
    safe(fun() ->
        Customer = aforo_metering_customer_resolver:resolve_connect(ClientInfo, ConnInfo),
        record(Customer, ClientInfo, <<"CONNECT">>, <<>>, 0, 0, false)
    end),
    ok.

on_client_disconnected(ClientInfo, _Reason, ConnInfo, _Env) ->
    safe(fun() ->
        Customer = aforo_metering_customer_resolver:resolve(ClientInfo),
        record(Customer, ClientInfo, <<"DISCONNECT">>, <<>>, 0, 0, false),
        aforo_metering_customer_resolver:on_disconnect(ClientInfo, ConnInfo)
    end),
    ok.

on_message_publish(Message = #message{from = From, topic = Topic, payload = Payload,
                                      qos = QoS, flags = Flags}, _Env) ->
    case is_system_topic(Topic) orelse not is_binary(From) of
        true -> ok;
        false ->
            safe(fun() ->
                %% message.publish only carries the clientid; the cache was
                %% filled at client.connected.
                Customer = aforo_metering_customer_resolver:lookup(From),
                record(Customer, #{clientid => From}, <<"PUBLISH">>, Topic,
                       payload_size(Payload), QoS, maps:get(retain, Flags, false))
            end)
    end,
    {ok, Message}.

on_message_delivered(ClientInfo, Message = #message{topic = Topic, payload = Payload,
                                                    qos = QoS, flags = Flags}, _Env) ->
    case aforo_metering_config:emit_deliver() andalso not is_system_topic(Topic) of
        false -> ok;
        true ->
            safe(fun() ->
                Customer = aforo_metering_customer_resolver:resolve(ClientInfo),
                record(Customer, ClientInfo, <<"DELIVER">>, Topic, payload_size(Payload),
                       QoS, maps:get(retain, Flags, false))
            end)
    end,
    {ok, Message}.

on_session_subscribed(ClientInfo, Topic, SubOpts, _Env) ->
    is_system_topic(Topic) orelse safe(fun() ->
        Customer = aforo_metering_customer_resolver:resolve(ClientInfo),
        record(Customer, ClientInfo, <<"SUBSCRIBE">>, Topic, 0, maps:get(qos, SubOpts, 0), false)
    end),
    ok.

on_session_unsubscribed(ClientInfo, Topic, _SubOpts, _Env) ->
    is_system_topic(Topic) orelse safe(fun() ->
        Customer = aforo_metering_customer_resolver:resolve(ClientInfo),
        record(Customer, ClientInfo, <<"UNSUBSCRIBE">>, Topic, 0, 0, false)
    end),
    ok.

%%--------------------------------------------------------------------
%% Recording
%%--------------------------------------------------------------------

%% Customer: binary (resolved), pending (async lookup running -- held
%% under the clientid until it answers) or undefined (no customer: the
%% event cannot be billed, so it is counted and dropped here).
record(undefined, _ClientInfo, _Type, _Topic, _Bytes, _QoS, _Retain) ->
    aforo_metering_metrics:inc('aforo.metering.events.unresolved', 1),
    aforo_metering_metrics:inc('aforo.metering.events.dropped', 1),
    ok;
record(Customer, ClientInfo, Type, Topic, Bytes, QoS, Retain) ->
    ClientId = clientid(ClientInfo),
    Owner = case Customer of
        pending -> {client, ClientId};
        C -> {customer, C}
    end,
    _ = aforo_metering_aggregator:record(Owner, Type, topic(Topic), Bytes,
                                         #{clientid => ClientId, qos => QoS, retain => Retain}),
    ok.

safe(Fun) ->
    try Fun()
    catch C:R:St ->
        ?SLOG(warning, #{msg => "aforo_metering hook failed; event not metered",
                         class => C, reason => R, stacktrace => St}),
        aforo_metering_metrics:inc('aforo.metering.events.dropped', 1),
        ok
    end.

%%--------------------------------------------------------------------
%% Helpers
%%--------------------------------------------------------------------

clientid(ClientInfo) ->
    case maps:get(clientid, ClientInfo, <<>>) of
        B when is_binary(B) -> B;
        A when is_atom(A) -> atom_to_binary(A, utf8);
        L when is_list(L) -> unicode:characters_to_binary(L);
        _ -> <<>>
    end.

topic(T) when is_binary(T) -> T;
topic(_) -> <<>>.

payload_size(undefined) -> 0;
payload_size(P) when is_binary(P) -> byte_size(P);
payload_size(P) when is_list(P)   -> iolist_size(P);
payload_size(_) -> 0.

is_system_topic(Topic) -> aforo_metering_aggregator:excluded(Topic).
