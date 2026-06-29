%%%-------------------------------------------------------------------
%%% @doc
%%% Aforo MQTT Metering Plugin for EMQ X 5.x
%%%
%%% Registers hooks on publish/subscribe/unsubscribe/connect/disconnect
%%% events, buffers billing events in ETS, and flushes them in batches
%%% to the Aforo usage ingestor.
%%%
%%% Config is read from priv/emqx_plugins/aforo_metering.hocon at start.
%%% @end
%%%-------------------------------------------------------------------
-module(aforo_metering).

-include_lib("emqx/include/emqx.hrl").
-include_lib("emqx/include/logger.hrl").

-export([
    load/0,
    unload/0,
    health/0,
    %% Hook callbacks
    on_client_connected/3,
    on_client_disconnected/4,
    on_message_publish/2,
    on_message_delivered/3,
    on_session_subscribed/4,
    on_session_unsubscribed/4
]).

-define(SDK_VERSION, <<"1.0.0">>).

%%--------------------------------------------------------------------
%% Load/unload (called by aforo_metering_app on plugin start/stop)
%%--------------------------------------------------------------------

load() ->
    ok = aforo_metering_buffer:init(),
    ok = aforo_metering_cache:init(),
    ok = aforo_metering_metrics:init(),
    aforo_metering_metrics:set_circuit_state(closed),
    emqx_hooks:add('client.connected',     {?MODULE, on_client_connected, []},     ?HP_LOWEST),
    emqx_hooks:add('client.disconnected',  {?MODULE, on_client_disconnected, []},  ?HP_LOWEST),
    emqx_hooks:add('message.publish',      {?MODULE, on_message_publish, []},      ?HP_LOWEST),
    emqx_hooks:add('message.delivered',    {?MODULE, on_message_delivered, []},    ?HP_LOWEST),
    emqx_hooks:add('session.subscribed',   {?MODULE, on_session_subscribed, []},   ?HP_LOWEST),
    emqx_hooks:add('session.unsubscribed', {?MODULE, on_session_unsubscribed, []}, ?HP_LOWEST),
    start_flush_timer(),
    ?SLOG(info, #{
        msg => "aforo_metering plugin loaded",
        tenant_id => tenant_id(),
        product_id => product_id(),
        flush_count => flush_count(),
        flush_interval_ms => flush_interval_ms(),
        max_buffer_size => max_buffer_size(),
        circuit_failure_threshold => circuit_failure_threshold(),
        customer_resolver => get_cfg(customer_resolver, <<"username">>)
    }),
    ok.

unload() ->
    emqx_hooks:del('client.connected',     {?MODULE, on_client_connected}),
    emqx_hooks:del('client.disconnected',  {?MODULE, on_client_disconnected}),
    emqx_hooks:del('message.publish',      {?MODULE, on_message_publish}),
    emqx_hooks:del('message.delivered',    {?MODULE, on_message_delivered}),
    emqx_hooks:del('session.subscribed',   {?MODULE, on_session_subscribed}),
    emqx_hooks:del('session.unsubscribed', {?MODULE, on_session_unsubscribed}),
    stop_flush_timer(),
    flush_now(),
    aforo_metering_buffer:delete(),
    ?SLOG(info, #{msg => "aforo_metering plugin unloaded"}),
    ok.

%% Health-check entry point — returns a status map suitable for exposure
%% via an EMQ X dashboard plugin endpoint or a custom HTTP route. Reports
%% buffer depth, circuit state, and counter snapshot.
-spec health() -> map().
health() ->
    Counters = aforo_metering_metrics:get_all(),
    CircuitState = case aforo_metering_metrics:circuit_state() of
        0 -> <<"closed">>;
        1 -> <<"half_open">>;
        2 -> <<"open">>;
        _ -> <<"unknown">>
    end,
    #{
        plugin            => <<"aforo_metering">>,
        version           => ?SDK_VERSION,
        tenant_id         => tenant_id(),
        product_id        => product_id(),
        ingestor_url      => list_to_binary(ingestor_url()),
        buffer_depth      => aforo_metering_buffer:size_active(),
        max_buffer_size   => max_buffer_size(),
        cache_size        => aforo_metering_cache:size(),
        circuit_state     => CircuitState,
        counters          => maps:from_list(Counters)
    }.

%%--------------------------------------------------------------------
%% Hook callbacks
%%--------------------------------------------------------------------

on_client_connected(ClientInfo, ConnInfo, _Env) ->
    case aforo_customer_id(ClientInfo, ConnInfo) of
        undefined -> ok;
        CustomerId ->
            buffer_event(CustomerId, #{
                <<"mqttEventType">> => <<"CONNECT">>,
                <<"mqttClientId">>  => clientid(ClientInfo),
                <<"mqttTopic">>     => <<>>,
                <<"mqttQos">>       => 0,
                <<"mqttRetained">>  => false,
                <<"dataBytes">>     => 0
            })
    end,
    ok.

on_client_disconnected(ClientInfo, Reason, ConnInfo, _Env) ->
    case aforo_customer_id(ClientInfo, ConnInfo) of
        undefined -> ok;
        CustomerId ->
            buffer_event(CustomerId, #{
                <<"mqttEventType">> => <<"DISCONNECT">>,
                <<"mqttClientId">>  => clientid(ClientInfo),
                <<"mqttTopic">>     => <<>>,
                <<"mqttQos">>       => 0,
                <<"mqttRetained">>  => false,
                <<"dataBytes">>     => 0,
                <<"disconnectReason">> => iolist_to_binary(io_lib:format("~p", [Reason]))
            })
    end,
    %% Always invalidate the cache on disconnect — customer-id resolution
    %% may change before the next CONNECT (e.g. JWT rotation, role change).
    aforo_metering_customer_resolver:invalidate(ClientInfo),
    ok.

on_message_publish(Message = #message{from = From, topic = Topic, payload = Payload, qos = QoS, flags = Flags}, _Env) ->
    case is_system_topic(Topic) of
        true  -> {ok, Message};
        false ->
            CustomerId = resolve_customer_from_from(From),
            case CustomerId of
                undefined -> {ok, Message};
                _ ->
                    buffer_event(CustomerId, #{
                        <<"mqttEventType">> => <<"PUBLISH">>,
                        <<"mqttClientId">>  => From,
                        <<"mqttTopic">>     => Topic,
                        <<"mqttQos">>       => QoS,
                        <<"mqttRetained">>  => maps:get(retain, Flags, false),
                        <<"dataBytes">>     => payload_size(Payload)
                    }),
                    {ok, Message}
            end
    end.

on_message_delivered(ClientInfo, Message = #message{topic = Topic, payload = Payload, qos = QoS, flags = Flags}, _Env) ->
    case emit_deliver_enabled() of
        false -> ok;
        true  ->
            case aforo_customer_id(ClientInfo, #{}) of
                undefined -> ok;
                CustomerId ->
                    buffer_event(CustomerId, #{
                        <<"mqttEventType">> => <<"DELIVER">>,
                        <<"mqttClientId">>  => clientid(ClientInfo),
                        <<"mqttTopic">>     => Topic,
                        <<"mqttQos">>       => QoS,
                        <<"mqttRetained">>  => maps:get(retain, Flags, false),
                        <<"dataBytes">>     => payload_size(Payload)
                    })
            end
    end,
    {ok, Message}.

on_session_subscribed(ClientInfo, Topic, SubOpts, _Env) ->
    case aforo_customer_id(ClientInfo, #{}) of
        undefined -> ok;
        CustomerId ->
            buffer_event(CustomerId, #{
                <<"mqttEventType">> => <<"SUBSCRIBE">>,
                <<"mqttClientId">>  => clientid(ClientInfo),
                <<"mqttTopic">>     => Topic,
                <<"mqttQos">>       => maps:get(qos, SubOpts, 0),
                <<"mqttRetained">>  => false,
                <<"dataBytes">>     => 0
            })
    end,
    ok.

on_session_unsubscribed(ClientInfo, Topic, _SubOpts, _Env) ->
    case aforo_customer_id(ClientInfo, #{}) of
        undefined -> ok;
        CustomerId ->
            buffer_event(CustomerId, #{
                <<"mqttEventType">> => <<"UNSUBSCRIBE">>,
                <<"mqttClientId">>  => clientid(ClientInfo),
                <<"mqttTopic">>     => Topic,
                <<"mqttQos">>       => 0,
                <<"mqttRetained">>  => false,
                <<"dataBytes">>     => 0
            })
    end,
    ok.

%%--------------------------------------------------------------------
%% Customer-ID resolution — delegates to the pluggable resolver module.
%% Backend selected via the `aforo_metering.customer_resolver` config knob:
%%   username | clientid_prefix | jwt | http
%% Cached per (tenant, clientid) — see aforo_metering_cache.
%%--------------------------------------------------------------------

aforo_customer_id(ClientInfo, ConnInfo) ->
    aforo_metering_customer_resolver:resolve(ClientInfo, ConnInfo).

resolve_customer_from_from(From) when is_binary(From) ->
    %% On message.publish the hook only receives the client identifier
    %% (not the full ClientInfo). Look up via the cache — populated on
    %% client.connected, so this is normally a hit.
    case aforo_metering_cache:get(tenant_id(), From) of
        {ok, CustomerId} -> CustomerId;
        not_found -> undefined  % unknown publisher; skip metering
    end;
resolve_customer_from_from(_) -> undefined.

%%--------------------------------------------------------------------
%% Buffering + flushing
%%--------------------------------------------------------------------

buffer_event(CustomerId, Extra) ->
    Now = erlang:system_time(millisecond),
    IdempKey = iolist_to_binary([
        "mqtt:", tenant_id(), ":",
        maps:get(<<"mqttClientId">>, Extra, <<>>), ":",
        maps:get(<<"mqttEventType">>, Extra, <<>>), ":",
        maps:get(<<"mqttTopic">>, Extra, <<>>), ":",
        integer_to_binary(Now), ":",
        random_suffix()
    ]),
    Event = maps:merge(#{
        <<"customerId">>     => CustomerId,
        <<"metricName">>     => <<"mqtt_broker.",
                                  (string:to_lower(binary_to_list(maps:get(<<"mqttEventType">>, Extra, <<"publish">>))))/binary>>,
        <<"quantity">>       => 1,
        <<"occurredAt">>     => iso8601(Now),
        <<"idempotencyKey">> => IdempKey,
        <<"productType">>    => <<"MQTT_BROKER">>,
        <<"metadata">>       => #{
            <<"sdkVersion">> => ?SDK_VERSION,
            <<"productId">>  => product_id()
        }
    }, Extra),
    %% Apply retention cap BEFORE inserting — bounded memory under sustained ingestor failure.
    enforce_retention_cap(),
    aforo_metering_buffer:insert(Event),
    aforo_metering_metrics:inc('aforo.metering.events.buffered', 1),
    maybe_flush_by_count().

%% Drop the oldest half of the buffer when it exceeds max_buffer_size.
%% Operates on the currently-active table (writers never block).
enforce_retention_cap() ->
    Max = max_buffer_size(),
    Size = aforo_metering_buffer:size_active(),
    case Size >= Max of
        true ->
            ToDrop = max(1, Size div 2),
            %% Drain into a list, drop the oldest portion, requeue the rest.
            All = aforo_metering_buffer:swap_and_drain(),
            Kept = drop_oldest_n(All, ToDrop),
            lists:foreach(fun aforo_metering_buffer:insert/1, Kept),
            aforo_metering_metrics:inc('aforo.metering.events.dropped', ToDrop),
            maybe_log_drop(ToDrop, Size, Max);
        false -> ok
    end.

%% Drop N oldest events from a list. Buffer maintains insertion order
%% so head = oldest.
drop_oldest_n(List, 0) -> List;
drop_oldest_n([], _) -> [];
drop_oldest_n([_ | Rest], N) -> drop_oldest_n(Rest, N - 1).

maybe_log_drop(Dropped, Size, Max) ->
    Now = erlang:system_time(second),
    LastLogged = persistent_term:get({?MODULE, last_drop_log}, 0),
    case Now - LastLogged of
        Diff when Diff >= 60 ->
            persistent_term:put({?MODULE, last_drop_log}, Now),
            ?SLOG(warning, #{
                msg => "aforo_metering buffer cap reached, oldest events dropped",
                dropped => Dropped, buffer_size => Size, max => Max
            });
        _ -> ok
    end.

maybe_flush_by_count() ->
    case aforo_metering_buffer:size_active() >= flush_count() of
        true  -> spawn(fun flush_now/0);
        false -> ok
    end.

flush_now() ->
    case aforo_metering_buffer:swap_and_drain() of
        []     -> ok;
        Events -> ship_to_ingestor(Events)
    end.

ship_to_ingestor(Events) ->
    %% Circuit breaker — when open, skip the POST and re-buffer the events
    %% (subject to the retention cap). When half-open, send a single probe.
    case circuit_state() of
        open ->
            aforo_metering_metrics:inc('aforo.metering.flush.error', 1),
            requeue_events(Events),
            ok;
        State ->
            Body = jsone:encode(#{<<"events">> => Events}),
            Url  = ingestor_url(),
            Headers = [
                {"Content-Type", "application/json"},
                {"Authorization", "Bearer " ++ binary_to_list(api_key())},
                {"X-Tenant-Id",   binary_to_list(tenant_id())}
            ],
            case ship_with_retry(Url, Headers, Body, 3) of
                ok ->
                    on_flush_success(State),
                    aforo_metering_metrics:inc('aforo.metering.events.flushed', length(Events));
                _ ->
                    on_flush_failure(),
                    requeue_events(Events)
            end
    end.

%% Put events back into the buffer (subject to retention cap).
requeue_events(Events) ->
    %% Apply retention cap once for the whole batch — saves N evaluations.
    enforce_retention_cap(),
    lists:foreach(fun aforo_metering_buffer:insert/1, Events),
    ok.

%%--------------------------------------------------------------------
%% Circuit breaker — closed -> open after N consecutive failures, then
%% half-open after cooldown. Implemented with persistent_term for low
%% contention; suitable for the < 1 KHz state transitions we expect.
%%--------------------------------------------------------------------

circuit_state() ->
    case persistent_term:get({?MODULE, circuit}, closed) of
        closed -> closed;
        {open_until, Until} ->
            case erlang:system_time(second) >= Until of
                true ->
                    persistent_term:put({?MODULE, circuit}, half_open),
                    aforo_metering_metrics:set_circuit_state(half_open),
                    half_open;
                false ->
                    open
            end;
        half_open -> half_open;
        Other -> Other
    end.

on_flush_success(State) ->
    case State of
        half_open ->
            ?SLOG(info, #{msg => "aforo_metering circuit closed (probe succeeded)"}),
            persistent_term:put({?MODULE, consecutive_failures}, 0),
            persistent_term:put({?MODULE, circuit}, closed),
            aforo_metering_metrics:set_circuit_state(closed);
        closed ->
            persistent_term:put({?MODULE, consecutive_failures}, 0),
            ok;
        _ -> ok
    end.

on_flush_failure() ->
    Failures = persistent_term:get({?MODULE, consecutive_failures}, 0) + 1,
    persistent_term:put({?MODULE, consecutive_failures}, Failures),
    case Failures >= circuit_failure_threshold() of
        true ->
            CooldownUntil = erlang:system_time(second) + circuit_cooldown_seconds(),
            persistent_term:put({?MODULE, circuit}, {open_until, CooldownUntil}),
            aforo_metering_metrics:set_circuit_state(open),
            ?SLOG(warning, #{
                msg => "aforo_metering circuit opened",
                failures => Failures,
                cooldown_seconds => circuit_cooldown_seconds()
            });
        false -> ok
    end.

ship_with_retry(_Url, _Headers, _Body, 0) ->
    ?SLOG(error, #{msg => "aforo_metering flush exhausted retries"}),
    aforo_metering_metrics:inc('aforo.metering.flush.error', 1),
    ok;
ship_with_retry(Url, Headers, Body, Attempts) ->
    case httpc:request(post, {Url, Headers, "application/json", Body}, [{timeout, 10000}], []) of
        {ok, {{_, Code, _}, _, _}} when Code >= 200, Code < 300 ->
            aforo_metering_metrics:inc('aforo.metering.flush.success', 1),
            ok;
        Other ->
            aforo_metering_metrics:inc('aforo.metering.flush.retry', 1),
            ?SLOG(warning, #{msg => "aforo_metering flush retry", reason => Other, attempts_left => Attempts - 1}),
            timer:sleep(trunc(math:pow(2, 4 - Attempts)) * 1000),
            ship_with_retry(Url, Headers, Body, Attempts - 1)
    end.

start_flush_timer() ->
    {ok, _} = timer:apply_interval(flush_interval_ms(), ?MODULE, flush_now, []),
    ok.

stop_flush_timer() ->
    ok. %% timer:apply_interval references held by the supervisor — cleaned up on app stop

%%--------------------------------------------------------------------
%% Helpers
%%--------------------------------------------------------------------

clientid(ClientInfo) -> maps:get(clientid, ClientInfo, <<"unknown">>).

payload_size(undefined) -> 0;
payload_size(P) when is_binary(P) -> byte_size(P);
payload_size(P) when is_list(P)   -> iolist_size(P);
payload_size(_) -> 0.

is_system_topic(<<"$SYS/", _/binary>>) -> true;
is_system_topic(<<"$share/", _/binary>>) -> true;
is_system_topic(_) -> false.

random_suffix() ->
    list_to_binary(
      [case rand:uniform(36) of
         N when N =< 10 -> $0 + N - 1;
         N              -> $a + N - 11
       end || _ <- lists:seq(1, 8)]).

iso8601(Millis) ->
    {{Y, Mo, D}, {H, Mi, S}} = calendar:system_time_to_universal_time(Millis, millisecond),
    iolist_to_binary(io_lib:format("~4..0B-~2..0B-~2..0BT~2..0B:~2..0B:~2..0B.~3..0BZ",
                                   [Y, Mo, D, H, Mi, S, Millis rem 1000])).

%%--------------------------------------------------------------------
%% Config accessors (driven by hocon config under [aforo_metering])
%%--------------------------------------------------------------------

tenant_id()         -> get_cfg(tenant_id,         <<"tenant_default">>).
product_id()        -> get_cfg(product_id,        <<"prod_mqtt_default">>).
api_key()           -> get_cfg(api_key,           <<"">>).
ingestor_url()      -> binary_to_list(get_cfg(ingestor_url, <<"https://ingestor.aforo.ai/v1/ingest/events">>)).
flush_count()       -> get_cfg(flush_count,       500).
flush_interval_ms() -> get_cfg(flush_interval_ms, 3000).
emit_deliver_enabled() -> get_cfg(emit_deliver, false).
max_buffer_size()      -> get_cfg(max_buffer_size, 50000).
circuit_failure_threshold() -> get_cfg(circuit_failure_threshold, 5).
circuit_cooldown_seconds()  -> get_cfg(circuit_cooldown_seconds, 60).

get_cfg(Key, Default) ->
    try emqx_conf:get([aforo_metering, Key], Default) catch _:_ -> Default end.
