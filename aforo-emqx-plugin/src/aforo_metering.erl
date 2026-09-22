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
    %% Called by timer:apply_interval/4 in start_flush_timer/0. It applies
    %% ?MODULE:flush_now() from another process, which only reaches exported
    %% functions: unexported, every interval tick crashed with undef and a
    %% partial batch (fewer than flush_count events) was never flushed at all.
    flush_now/0,
    %% Hook callbacks
    on_client_connected/3,
    on_client_disconnected/4,
    on_message_publish/2,
    on_message_delivered/3,
    on_session_subscribed/4,
    on_session_unsubscribed/4
]).

-define(SDK_VERSION, <<"1.0.0">>).
%% The ingestor rejects batches of more than 1000 events (IngestBatchRequest).
-define(MAX_BATCH_SIZE, 1000).
-define(MAX_ATTEMPTS, 3).

-ifdef(TEST).
-export([classify_response/1, chunk/2, has_customer/1]).
-endif.

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

%% Refuse an event that can never be accepted (2026-09-21), mirroring the Kong
%% plugin. The ingestor rejects a blank customerId and validates a batch as a
%% whole, so one such event fails the request and takes every well-formed event
%% batched with it down too. Nothing later can supply the missing value, so it is
%% dropped here, where the loss is limited to the event actually at fault. The
%% resolvers return `undefined' for "no customer", but a backend (the http one
%% especially) can still hand back an empty string.
buffer_event(CustomerId, Extra) ->
    case has_customer(CustomerId) of
        true  -> do_buffer_event(CustomerId, Extra);
        false ->
            aforo_metering_metrics:inc('aforo.metering.events.dropped', 1),
            ok
    end.

has_customer(undefined) -> false;
has_customer(null) -> false;
has_customer(<<>>) -> false;
has_customer("") -> false;
has_customer(B) when is_binary(B) -> string:trim(B) =/= <<>>;
has_customer(L) when is_list(L) -> string:trim(L) =/= "";
has_customer(_) -> false.

do_buffer_event(CustomerId, Extra) ->
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
            %% Belt and braces for buffer_event's guard: anything already in the
            %% buffer without a customer would fail its whole batch.
            {Sendable, Blank} = lists:partition(
                fun(E) -> has_customer(maps:get(<<"customerId">>, E, undefined)) end, Events),
            case Blank of
                [] -> ok;
                _  -> aforo_metering_metrics:inc('aforo.metering.events.dropped', length(Blank))
            end,
            ship_batches(State, chunk(Sendable, ?MAX_BATCH_SIZE))
    end.

%% The ingestor rejects a batch of more than 1000 events with 400. flush_count
%% defaults to 500, but a flush drains the WHOLE buffer -- up to max_buffer_size
%% (50000) after an outage -- so without slicing, the first flush after the
%% ingestor recovered would be one oversized request, rejected outright.
ship_batches(_State, []) ->
    ok;
ship_batches(State, [Batch | Rest]) ->
    Body = jsone:encode(#{<<"events">> => Batch}),
    case ship_with_retry(ingestor_url(), ingest_headers(), Body, ?MAX_ATTEMPTS) of
        ok ->
            on_flush_success(State),
            aforo_metering_metrics:inc('aforo.metering.events.flushed', length(Batch)),
            ship_batches(closed_if_probe(State), Rest);
        {error, {rejected, Code, RespBody}} ->
            %% Drop on a permanent rejection; only retry what retrying can fix.
            %% A 4xx means the ingestor understood the batch and refused it, so
            %% re-queueing sends identical bytes to an identical judgement --
            %% forever, and dragging every good event queued behind it down
            %% too. Logged at error with the response body so a dropped batch
            %% says why. The ingestor answered, so this is not an availability
            %% failure and does not count toward opening the circuit.
            ?SLOG(error, #{
                msg => "aforo_metering ingestor rejected batch, dropping it",
                status => Code,
                dropped => length(Batch),
                response => truncate(RespBody, 500)
            }),
            aforo_metering_metrics:inc('aforo.metering.flush.error', 1),
            aforo_metering_metrics:inc('aforo.metering.events.dropped', length(Batch)),
            on_flush_success(State),
            ship_batches(closed_if_probe(State), Rest);
        {error, Reason} ->
            %% Transient (5xx, 408, 429, timeout, connection refused): keep
            %% this batch and everything after it, and stop -- the next slice
            %% would only fail the same way. This is the failure the circuit
            %% breaker counts; before 2026-09-21 ship_with_retry reported `ok'
            %% here, so exhausted retries counted as sent, the events were
            %% discarded, and the circuit could never open.
            ?SLOG(error, #{
                msg => "aforo_metering flush failed, events re-queued",
                reason => Reason,
                requeued => length(Batch) + lists:sum([length(B) || B <- Rest])
            }),
            aforo_metering_metrics:inc('aforo.metering.flush.error', 1),
            on_flush_failure(),
            requeue_events(lists:append([Batch | Rest]))
    end.

%% After a successful half-open probe the circuit is closed for later slices.
closed_if_probe(half_open) -> closed;
closed_if_probe(State) -> State.

%% X-API-Key, not Authorization: Bearer (2026-09-21), matching the Kong fix.
%% The ingestor authenticates keys through aforo-common's ApiKeyAuthFilter,
%% which reads X-API-Key and nothing else. Sent ALONE: a key in an
%% Authorization: Bearer header is parsed as a JWT, fails, and the request is
%% rejected 401 before the API-key filter runs -- even when X-API-Key is also
%% present.
ingest_headers() ->
    [
        {"X-API-Key",   binary_to_list(api_key())},
        {"X-Tenant-Id", binary_to_list(tenant_id())}
    ].

chunk([], _N) -> [];
chunk(List, N) when length(List) =< N -> [List];
chunk(List, N) ->
    {Head, Tail} = lists:split(N, List),
    [Head | chunk(Tail, N)].

truncate(Bin, Max) when is_binary(Bin), byte_size(Bin) > Max -> binary:part(Bin, 0, Max);
truncate(Bin, _Max) when is_binary(Bin) -> Bin;
truncate(List, Max) when is_list(List) -> truncate(iolist_to_binary(List), Max);
truncate(Other, _Max) -> Other.

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

%% Returns ok, {error, {rejected, Code, Body}} for a permanent 4xx, or
%% {error, Reason} once a transient failure has used up its attempts.
ship_with_retry(Url, Headers, Body, AttemptsLeft) ->
    Result = httpc:request(post, {Url, Headers, "application/json", Body},
                           [{timeout, 10000}], [{body_format, binary}]),
    case classify_response(Result) of
        ok ->
            aforo_metering_metrics:inc('aforo.metering.flush.success', 1),
            ok;
        {rejected, _Code, _RespBody} = Rejected ->
            %% Same bytes, same judgement: retrying a 4xx only delays the drop.
            {error, Rejected};
        {transient, Reason} when AttemptsLeft > 1 ->
            aforo_metering_metrics:inc('aforo.metering.flush.retry', 1),
            ?SLOG(warning, #{msg => "aforo_metering flush retry", reason => Reason,
                             attempts_left => AttemptsLeft - 1}),
            %% 1s, 2s between the three attempts. The old schedule also slept
            %% 8s after the final attempt, before giving up.
            timer:sleep(trunc(math:pow(2, ?MAX_ATTEMPTS - AttemptsLeft)) * 1000),
            ship_with_retry(Url, Headers, Body, AttemptsLeft - 1);
        {transient, Reason} ->
            ?SLOG(error, #{msg => "aforo_metering flush exhausted retries", reason => Reason}),
            {error, Reason}
    end.

%% 2xx is success. 4xx is a permanent rejection, except 408 and 429, which
%% explicitly invite a retry. Everything else -- 5xx, timeouts, connection
%% errors -- is transient. Same rule as the Kong plugin.
classify_response({ok, {{_, Code, _}, _, _}}) when Code >= 200, Code < 300 ->
    ok;
classify_response({ok, {{_, Code, _}, _, RespBody}})
  when Code >= 400, Code < 500, Code =/= 408, Code =/= 429 ->
    {rejected, Code, RespBody};
classify_response({ok, {{_, Code, _}, _, _}}) ->
    {transient, {http_status, Code}};
classify_response({error, Reason}) ->
    {transient, Reason};
classify_response(Other) ->
    {transient, Other}.

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
%% /v1/ingest/batch, not /v1/ingest/events (2026-09-21). The plugin POSTs
%% {"events": [...]}, which is the batch endpoint's contract; /v1/ingest/events
%% is the single-event, Apigee-format endpoint. And api.aforo.ai (the
%% public gateway in front of the ingestor), not ingestor.aforo.ai: the
%% latter resolves to a static CloudFront/S3 site that answers a POST with
%% a 301, so no event ever reached the ingestor.
ingestor_url()      -> binary_to_list(get_cfg(ingestor_url, <<"https://api.aforo.ai/v1/ingest/batch">>)).
flush_count()       -> get_cfg(flush_count,       500).
flush_interval_ms() -> get_cfg(flush_interval_ms, 3000).
emit_deliver_enabled() -> get_cfg(emit_deliver, false).
max_buffer_size()      -> get_cfg(max_buffer_size, 50000).
circuit_failure_threshold() -> get_cfg(circuit_failure_threshold, 5).
circuit_cooldown_seconds()  -> get_cfg(circuit_cooldown_seconds, 60).

get_cfg(Key, Default) ->
    try emqx_conf:get([aforo_metering, Key], Default) catch _:_ -> Default end.
