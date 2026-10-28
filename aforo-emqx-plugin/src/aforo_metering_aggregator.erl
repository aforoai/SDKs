%%%-------------------------------------------------------------------
%%% @doc
%%% Per-window usage aggregation for the Aforo MQTT Metering plugin.
%%%
%%% Before 2.0.0 every PUBLISH / DELIVER / SUBSCRIBE / ... became its own
%%% usage event with quantity 1. At IoT rates that is one HTTP-borne
%%% event per message. Now each broker event only bumps a counter:
%%%
%%%   key   = {WindowStart, Owner, EventType, Topic, Detail}
%%%   value = message count, payload bytes
%%%
%%% `Owner' is {customer, Id}, or {client, ClientId} while an async
%%% customer lookup is still running. `Topic' is the MQTT topic when
%%% `aggregate_by_topic = true', otherwise "#" (all topics). `Detail' is
%%% {agg, QoS, Retain} when aggregating -- QoS (0-2) and the retain flag
%%% stay dimensions so descriptor filters on mqtt_qos / mqtt_retained keep
%%% matching; with `aggregation_window_seconds = 0' it is a unique
%%% per-event term (plus clientid / QoS / retain), so every broker event
%%% stays its own usage event.
%%%
%%% The hot path is one ets:update_counter/4 call (atomic, lock-free
%%% under write_concurrency); no process is messaged and nothing is
%%% drained or re-inserted in the publisher's process. The number of
%%% open keys is capped (`max_aggregation_keys'): a new key over the
%%% cap is dropped and counted, an existing key keeps counting.
%%%
%%% The flusher calls `close_windows/1' once per tick. A window closes a
%%% grace period after it ends. Each closed row becomes one usage event
%%% with quantity = message count and an idempotency key derived from
%%% (tenant, product, node, plugin incarnation, window start, owner,
%%% event type, topic, detail, emission number). The key is computed
%%% once and travels with the event, so every re-send after a failure
%%% carries the same key and the ingestor deduplicates it (Rule #21).
%%% The node and incarnation keep two broker nodes, or two lives of one
%%% node, from producing the same key for different traffic. The
%%% emission number covers a counter increment that lands after its
%%% window was emitted: it is sent as a second event with its own key
%%% instead of being lost as a "duplicate".
%%% @end
%%%-------------------------------------------------------------------
-module(aforo_metering_aggregator).

-export([
    init/0,
    delete/0,
    record/5,
    close_windows/1,
    close_windows/2,
    close_open_windows/2,
    close_all/0,
    reconfigure/0,
    open_keys/0,
    settings/0,
    excluded/1
]).

-define(TAB, aforo_metering_agg).
-define(EMITTED, aforo_metering_agg_emitted).
-define(SETTINGS, {?MODULE, settings}).
-define(GRACE_MS, 1000).
-define(SDK_VERSION, <<"2.0.1">>).
%% IngestUsageEventRequest.mqttTopic is @Size(max = 500). Truncating at
%% 500 bytes keeps it within 500 UTF-16 code units.
-define(MAX_TOPIC_BYTES, 500).
-define(MAX_CLIENTID_BYTES, 128).

%%--------------------------------------------------------------------
%% Lifecycle
%%--------------------------------------------------------------------

-spec init() -> ok.
init() ->
    %% ordered_set: keys start with the window, so ets:first/1 is the
    %% oldest open window (used when pruning emission counters).
    ensure(?TAB, [named_table, public, ordered_set, {write_concurrency, true}, {read_concurrency, true}]),
    ensure(?EMITTED, [named_table, public, set]),
    persistent_term:put(?SETTINGS, current_settings(#{
        node => atom_to_binary(node(), utf8),
        incarnation => crypto:strong_rand_bytes(16)
    })),
    ok.

current_settings(Identity) ->
    Identity#{
        window_ms => aforo_metering_config:aggregation_window_ms(),
        by_topic => aforo_metering_config:aggregate_by_topic(),
        max_keys => aforo_metering_config:max_aggregation_keys(),
        flush_count => aforo_metering_config:flush_count(),
        exclude => [binary:split(F, <<"/">>, [global])
                    || F <- aforo_metering_config:exclude_topics()],
        tenant => aforo_metering_config:tenant_id(),
        product => aforo_metering_config:product_id()
    }.

%% Re-read the settings after a config change (flusher process only, so
%% no tick interleaves). The node and incarnation stay: the idempotency
%% keys of usage already counted must not change. Returns `reshaped'
%% when the window length or the topic dimension changed -- the caller
%% then closes the windows opened under the old shape at once
%% (close_open_windows/2), sending them as partial windows. A hook that
%% read the old settings an instant before the swap can still add to an
%% old-shape row after that; the row keeps its count and closes on a
%% later tick (its metadata names the new window length). Counts are
%% never lost or doubled: a row emitted twice gets a new emission
%% number, so a new idempotency key.
-spec reconfigure() -> unchanged | reshaped.
reconfigure() ->
    Old = settings(),
    New = current_settings(maps:with([node, incarnation], Old)),
    persistent_term:put(?SETTINGS, New),
    case maps:with([window_ms, by_topic], Old) =:= maps:with([window_ms, by_topic], New) of
        true -> unchanged;
        false -> reshaped
    end.

ensure(Name, Opts) ->
    case ets:info(Name) of
        undefined -> _ = ets:new(Name, Opts), ok;
        _ -> ok
    end.

-spec delete() -> ok.
delete() ->
    try ets:delete(?TAB) catch _:_ -> ok end,
    try ets:delete(?EMITTED) catch _:_ -> ok end,
    try persistent_term:erase(?SETTINGS) catch _:_ -> ok end,
    ok.

settings() -> persistent_term:get(?SETTINGS).

%% True when Topic matches one of the `exclude_topics' filters. `$SYS/'
%% and `$share/' are always excluded.
-spec excluded(term()) -> boolean().
excluded(<<"$SYS/", _/binary>>) -> true;
excluded(<<"$share/", _/binary>>) -> true;
excluded(Topic) when is_binary(Topic) ->
    Words = binary:split(Topic, <<"/">>, [global]),
    Filters = maps:get(exclude, persistent_term:get(?SETTINGS, #{}), []),
    lists:any(fun(F) -> filter_match(F, Words, true) end, Filters);
excluded(_) -> false.

%% MQTT 5 4.7.2: a filter starting with a wildcard does not match a
%% topic starting with "$".
filter_match([W | _], [<<"$", _/binary>> | _], true) when W =:= <<"#">>; W =:= <<"+">> -> false;
filter_match([<<"#">>], _Words, _First) -> true;
filter_match([<<"+">> | F], [_ | T], _First) -> filter_match(F, T, false);
filter_match([W | F], [W | T], _First) -> filter_match(F, T, false);
filter_match([], [], _First) -> true;
filter_match(_, _, _) -> false.

-spec open_keys() -> non_neg_integer().
open_keys() ->
    case ets:info(?TAB, size) of
        N when is_integer(N) -> N;
        _ -> 0
    end.

%%--------------------------------------------------------------------
%% Hot path
%%--------------------------------------------------------------------

%% Owner: {customer, binary()} | {client, binary()}
%% Info: #{clientid, qos, retain} -- used only without aggregation.
-spec record({customer | client, binary()}, binary(), binary(), non_neg_integer(), map()) ->
    ok | dropped.
record(Owner, EventType, Topic, Bytes, Info) ->
    #{window_ms := WindowMs, by_topic := ByTopic, max_keys := MaxKeys} = settings(),
    Now = erlang:system_time(millisecond),
    {WindowStart, Detail} = case WindowMs of
        0 -> {Now, {erlang:unique_integer([positive]),
                    maps:get(clientid, Info, <<>>),
                    maps:get(qos, Info, 0),
                    maps:get(retain, Info, false)}};
        _ -> {Now - (Now rem WindowMs),
              {agg, maps:get(qos, Info, 0), maps:get(retain, Info, false) =:= true}}
    end,
    TopicDim = case ByTopic orelse WindowMs =:= 0 of
        true -> topic_dim(Topic);
        false -> <<"#">>
    end,
    Key = {WindowStart, Owner, EventType, TopicDim, Detail},
    case ets:member(?TAB, Key) orelse ets:info(?TAB, size) < MaxKeys of
        true ->
            _ = ets:update_counter(?TAB, Key, [{2, 1}, {3, Bytes}], {Key, 0, 0}),
            aforo_metering_metrics:inc('aforo.metering.events.buffered', 1),
            %% Without aggregation every row is ready at once: wake the
            %% flusher when a batch is waiting (a no-op if already woken).
            case WindowMs =:= 0 andalso ets:info(?TAB, size) >= maps:get(flush_count, settings()) of
                true -> aforo_metering_flusher:wake();
                false -> ok
            end,
            ok;
        false ->
            aforo_metering_metrics:inc('aforo.metering.events.dropped', 1),
            aforo_metering_metrics:inc('aforo.metering.aggregation.keys_dropped', 1),
            dropped
    end.

topic_dim(<<>>) -> <<"#">>;
topic_dim(T) when is_binary(T) -> truncate_utf8(T, ?MAX_TOPIC_BYTES);
topic_dim(_) -> <<"#">>.

%%--------------------------------------------------------------------
%% Closing windows (flusher process only)
%%--------------------------------------------------------------------

%% Returns {Events, DroppedMessages}. Rows whose customer is still being
%% resolved stay open until `customer_resolver_pending_max_seconds'.
%% At most Limit events are produced: the flusher passes the room left
%% in its queue, so closed windows wait in the (capped) counter table
%% instead of evicting queued events while the ingestor keeps up.
-spec close_windows(integer()) -> {[map()], non_neg_integer()}.
close_windows(NowMs) -> close_windows(NowMs, infinity).

-spec close_windows(integer(), non_neg_integer() | infinity) -> {[map()], non_neg_integer()}.
close_windows(_NowMs, 0) -> {[], 0};
close_windows(NowMs, Limit) ->
    #{window_ms := WindowMs} = settings(),
    Cutoff = case WindowMs of
        0 -> NowMs;
        _ -> NowMs - WindowMs - ?GRACE_MS
    end,
    close_upto(Cutoff, NowMs, Limit).

%% Close every window that has started, finished or not (used when the
%% window shape changes). Rows still waiting for a customer stay pending
%% as usual; rows beyond Limit stay in the table and close on later ticks.
-spec close_open_windows(integer(), non_neg_integer() | infinity) ->
    {[map()], non_neg_integer()}.
close_open_windows(_NowMs, 0) -> {[], 0};
close_open_windows(NowMs, Limit) ->
    close_upto(NowMs, NowMs, Limit).

close_upto(Cutoff, NowMs, Limit) ->
    #{window_ms := WindowMs} = settings(),
    Rows = ets:select(?TAB, [{{{'$1', '_', '_', '_', '_'}, '_', '_'},
                              [{'=<', '$1', Cutoff}], ['$_']}]),
    PendingMax = aforo_metering_config:pending_max_ms(),
    R = close_rows(sort_rows(Rows), NowMs, PendingMax, Limit, {[], 0}),
    prune_emitted(NowMs, WindowMs),
    finish(R).

%% Room counts down as events are produced (infinity never does).
close_rows([], _NowMs, _PendingMax, _Room, Acc) -> Acc;
close_rows(_Rows, _NowMs, _PendingMax, 0, Acc) -> Acc;
close_rows([Row | Rest], NowMs, PendingMax, Room, Acc = {Evs0, _}) ->
    Acc1 = {Evs1, _} = close_row(Row, NowMs, PendingMax, false, Acc),
    Room1 = case {Room, Evs1 =/= Evs0} of
        {infinity, _} -> infinity;
        {_, true} -> Room - 1;
        {_, false} -> Room
    end,
    close_rows(Rest, NowMs, PendingMax, Room1, Acc1).

%% Shutdown: close every window, finished or not. Rows still waiting
%% for a customer are dropped (counted by the caller).
-spec close_all() -> {[map()], non_neg_integer()}.
close_all() ->
    Rows = try ets:tab2list(?TAB) catch error:badarg -> [] end,
    finish(lists:foldl(fun(Row, Acc) -> close_row(Row, 0, 0, true, Acc) end,
                       {[], 0}, sort_rows(Rows))).

finish({EventsRev, Dropped}) -> {lists:reverse(EventsRev), Dropped}.

sort_rows(Rows) -> lists:keysort(1, Rows).

close_row({Key = {WindowStart, Owner, _, _, _}, _, _}, NowMs, PendingMax, Final, {Evs, Dropped}) ->
    case owner_customer(Owner) of
        {ok, Customer} ->
            case take(Key) of
                {Count, Bytes} when Count > 0 ->
                    {[build_event(Key, Customer, Count, Bytes) | Evs], Dropped};
                _ -> {Evs, Dropped}
            end;
        pending when not Final, NowMs - WindowStart < PendingMax ->
            {Evs, Dropped};
        _ ->
            %% No customer (resolver said none, failed, timed out, or we
            %% are shutting down): the usage cannot be billed to anyone.
            case take(Key) of
                {Count, _} ->
                    aforo_metering_metrics:inc('aforo.metering.events.unresolved', Count),
                    aforo_metering_metrics:inc('aforo.metering.events.dropped', Count),
                    {Evs, Dropped + Count};
                _ -> {Evs, Dropped}
            end
    end.

owner_customer({customer, C}) -> {ok, C};
owner_customer({client, ClientId}) ->
    case aforo_metering_customer_resolver:lookup(ClientId) of
        pending -> pending;
        undefined -> none;
        C -> {ok, C}
    end.

take(Key) ->
    case ets:take(?TAB, Key) of
        [{_, Count, Bytes}] -> {Count, Bytes};
        [] -> none
    end.

%%--------------------------------------------------------------------
%% Event construction
%%--------------------------------------------------------------------

build_event(Key = {WindowStart, Owner, EventType, Topic, Detail}, Customer, Count, Bytes) ->
    #{window_ms := WindowMs, tenant := Tenant, product := Product,
      node := Node, incarnation := Inc} = settings(),
    Seq = case Detail of
        {agg, _, _} -> ets:update_counter(?EMITTED, Key, 1, {Key, -1});
        _ -> 0
    end,
    Digest = crypto:hash(sha256, term_to_binary(
        {aforo_mqtt_v2, Tenant, Product, Node, Inc, WindowStart, Owner, EventType, Topic,
         Detail, Seq})),
    IdempKey = <<"mqtt:", (binary:encode_hex(Digest, lowercase))/binary>>,
    Base = #{
        <<"customerId">>     => Customer,
        <<"metricName">>     => <<"mqtt_broker.", (string:lowercase(EventType))/binary>>,
        <<"quantity">>       => Count,
        <<"occurredAt">>     => iso8601(WindowStart),
        <<"idempotencyKey">> => IdempKey,
        <<"productType">>    => <<"MQTT_BROKER">>,
        <<"mqttEventType">>  => EventType,
        <<"mqttTopic">>      => Topic,
        <<"dataBytes">>      => Bytes,
        <<"metadata">>       => #{
            <<"sdkVersion">> => ?SDK_VERSION,
            <<"productId">>  => Product,
            <<"aggregationWindowSeconds">> => WindowMs div 1000,
            <<"messageCount">> => Count
        }
    },
    case Detail of
        {agg, QoS, Retain} ->
            Base#{<<"mqttQos">> => QoS, <<"mqttRetained">> => Retain};
        {_Unique, ClientId, QoS, Retain} ->
            Base#{<<"mqttClientId">> => truncate_utf8(ClientId, ?MAX_CLIENTID_BYTES),
                  <<"mqttQos">> => QoS,
                  <<"mqttRetained">> => Retain}
    end.

%% Forget emission counters for windows far in the past -- never for a
%% window that still has open rows (deferred or pending), or its next
%% emission would reuse the first emission's key and be deduplicated.
prune_emitted(_NowMs, 0) -> ok;
prune_emitted(NowMs, WindowMs) ->
    Oldest = case ets:first(?TAB) of
        {W, _, _, _, _} -> W;
        '$end_of_table' -> NowMs
    end,
    Old = min(NowMs - 10 * WindowMs - ?GRACE_MS, Oldest),
    _ = ets:select_delete(?EMITTED, [{{{'$1', '_', '_', '_', '_'}, '_'},
                                      [{'<', '$1', Old}], [true]}]),
    ok.

iso8601(Millis) ->
    {{Y, Mo, D}, {H, Mi, S}} = calendar:system_time_to_universal_time(Millis, millisecond),
    iolist_to_binary(io_lib:format("~4..0B-~2..0B-~2..0BT~2..0B:~2..0B:~2..0B.~3..0BZ",
                                   [Y, Mo, D, H, Mi, S, Millis rem 1000])).

%% Cut at a UTF-8 character boundary.
truncate_utf8(B, Max) when is_binary(B), byte_size(B) =< Max -> B;
truncate_utf8(B, Max) when is_binary(B) ->
    Cut = binary:part(B, 0, Max),
    back_to_boundary(Cut, Cut, 3);
truncate_utf8(_, _) -> <<>>.

%% Drop at most 3 trailing bytes (a split UTF-8 sequence). Input that is
%% not UTF-8 at all is returned cut but otherwise unchanged.
back_to_boundary(Orig, _B, -1) -> Orig;
back_to_boundary(Orig, B, N) ->
    case unicode:characters_to_binary(B) of
        B2 when is_binary(B2), B2 =/= <<>> -> B2;
        _ when byte_size(B) > 1 -> back_to_boundary(Orig, binary:part(B, 0, byte_size(B) - 1), N - 1);
        _ -> Orig
    end.
