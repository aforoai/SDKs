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

-define(VERSION, <<"2.0.1">>).

%%--------------------------------------------------------------------
%% Lifecycle (aforo_metering_app)
%%--------------------------------------------------------------------

%% Before the supervision tree starts: refuse a bad configuration.
-spec prepare() -> ok | {error, term()}.
prepare() ->
    case aforo_metering_config:validate() of
        ok ->
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
    emqx_hooks:add('client.connected',     {?MODULE, on_client_connected, []},     ?HP_LOWEST),
    emqx_hooks:add('client.disconnected',  {?MODULE, on_client_disconnected, []},  ?HP_LOWEST),
    emqx_hooks:add('message.publish',      {?MODULE, on_message_publish, []},      ?HP_LOWEST),
    emqx_hooks:add('message.delivered',    {?MODULE, on_message_delivered, []},    ?HP_LOWEST),
    emqx_hooks:add('session.subscribed',   {?MODULE, on_session_subscribed, []},   ?HP_LOWEST),
    emqx_hooks:add('session.unsubscribed', {?MODULE, on_session_unsubscribed, []}, ?HP_LOWEST),
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
%% also while the plugin is installed but stopped. On 5.9+ returning
%% `{error, Reason}' rejects the change (it is not saved); 5.8 ignores
%% the return value and saves the change anyway, so a refused change is
%% also logged at error and the running plugin keeps its current config.
%% (5.7 has no callback: restart the plugin after a change.)
%%
%% NewConfig has already passed priv/config_schema.avsc. Checks here are
%% the same on every node (no file or network checks -- see
%% aforo_metering_config:validate/1); node-local problems show in
%% on_health_check/1.
%%
%% While running, the change is applied in place, nothing queued is
%% dropped:
%%   * delivery settings (URL, key, CA, timeouts, retries) take effect
%%     on the next request, and a paused delivery is retried at once;
%%   * flush_count / flush_interval_ms / max_buffer_size and the
%%     aggregation settings are applied inside the flusher between
%%     ticks; a new window length or topic dimension closes the open
%%     windows at once (sent as partial windows);
%%   * the http resolver pool takes the new worker and queue sizes;
%%     customers already resolved stay cached until their connection
%%     ends, so publishers stay attributed.
%% tenant_id and product_id cannot change while running: usage already
%% counted belongs to the old ones. Stop the plugin, change them, start.
-spec on_config_changed(map(), map()) -> ok | {error, binary()}.
on_config_changed(_OldConfig, NewConfig) when is_map(NewConfig) ->
    Candidate = aforo_metering_config:normalize(NewConfig),
    case aforo_metering_config:validate(Candidate) of
        {error, Reasons} ->
            [?SLOG(error, #{msg => "aforo_metering rejected a config change", reason => R})
             || R <- Reasons],
            {error, join(Reasons)};
        ok ->
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

apply_running(Candidate) ->
    Current = aforo_metering_config:snapshot(),
    Changed = [K || {K, _, _} <- aforo_metering_config:spec(),
                    maps:get(K, Current, undefined) =/= maps:get(K, Candidate, undefined)],
    Identity = [K || K <- [tenant_id, product_id], lists:member(K, Changed),
                     value(K, Current) =/= value(K, Candidate)],
    case Identity of
        [] when Changed =:= [] ->
            ok = aforo_metering_config:put_snapshot(Candidate),
            ok;
        [] ->
            ok = aforo_metering_config:put_snapshot(Candidate),
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
            ok;
        _ ->
            Reason = <<"tenant_id and product_id cannot change while the plugin is running ",
                       "(usage already counted belongs to the current ones); stop the plugin, ",
                       "change them, then start it">>,
            ?SLOG(error, #{msg => "aforo_metering rejected a config change", reason => Reason,
                           keys => Identity}),
            {error, Reason}
    end.

value(K, Conf) ->
    case maps:get(K, Conf, <<>>) of
        V when is_binary(V) -> string:trim(V);
        V when is_list(V) -> string:trim(unicode:characters_to_binary(V));
        V -> V
    end.

%% EMQX 5.9+ calls this when the plugin's info is requested.
-spec on_health_check(map()) -> ok | {error, binary()}.
on_health_check(_Options) ->
    case aforo_metering_config:check_environment() of
        {error, Reasons} -> {error, join(Reasons)};
        ok ->
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
