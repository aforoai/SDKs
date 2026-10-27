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
    %% Hook callbacks
    on_client_connected/3,
    on_client_disconnected/4,
    on_message_publish/2,
    on_message_delivered/3,
    on_session_subscribed/4,
    on_session_unsubscribed/4
]).

-define(VERSION, <<"2.0.0">>).

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
        max_buffer_size => aforo_metering_config:max_buffer_size()
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
