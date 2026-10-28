%%%-------------------------------------------------------------------
%%% @doc
%%% Counter-based metrics for the Aforo MQTT Metering plugin.
%%%
%%% Uses EMQ X's built-in emqx_metrics facility (backed by atomic
%%% counters). Emits gauge/counter values that can be scraped via the
%%% EMQ X Prometheus endpoint at /api/v5/prometheus/stats.
%%%
%%% Counters:
%%%   aforo.metering.events.buffered          — broker events recorded (one per message)
%%%   aforo.metering.events.flushed           — usage events the ingestor accepted
%%%   aforo.metering.events.rejected          — usage events the ingestor refused (4xx / errors[])
%%%   aforo.metering.events.dropped           — usage lost: queue overflow, rejection,
%%%                                             aggregation-key cap, shutdown deadline
%%%   aforo.metering.events.unresolved        — broker events with no customer (dropped)
%%%   aforo.metering.aggregation.keys_dropped — events refused because max_aggregation_keys was hit
%%%   aforo.metering.flush.success            — 2xx answers from the ingestor
%%%   aforo.metering.flush.retry              — retried requests
%%%   aforo.metering.flush.error              — sends that ended in an outage (breaker opened)
%%%   aforo.metering.customer_lookup.hit      — cache hits in customer-id resolver
%%%   aforo.metering.customer_lookup.miss     — cache misses (resolver invoked)
%%%   aforo.metering.customer_lookup.negative — cached "no customer" answers
%%%   aforo.metering.resolver.dropped         — http lookups refused because the queue was full
%%%
%%% Gauges (persistent_term-backed, set/circuit_state/get_circuit_state):
%%%   aforo.metering.circuit.state            — 0 = closed, 1 = half_open, 2 = open
%%%   aforo.metering.config.invalid           — 1 = EMQX saved a config change the
%%%                                             plugin refused (EMQX 5.8 saves it
%%%                                             anyway); the next start will fail
%%%                                             until it is fixed. 0 otherwise.
%%% @end
%%%-------------------------------------------------------------------
-module(aforo_metering_metrics).

-export([
    val/1,
    init/0,
    inc/1,
    inc/2,
    set_circuit_state/1,
    circuit_state/0,
    set_config_invalid/1,
    config_invalid/0,
    get_all/0
]).

-define(COUNTERS, [
    'aforo.metering.events.buffered',
    'aforo.metering.events.flushed',
    'aforo.metering.events.dropped',
    'aforo.metering.events.rejected',
    'aforo.metering.events.unresolved',
    'aforo.metering.aggregation.keys_dropped',
    'aforo.metering.flush.success',
    'aforo.metering.flush.retry',
    'aforo.metering.flush.error',
    'aforo.metering.customer_lookup.hit',
    'aforo.metering.customer_lookup.miss',
    'aforo.metering.customer_lookup.negative',
    'aforo.metering.resolver.dropped'
]).

-define(CIRCUIT_STATE_KEY, {?MODULE, circuit_state}).
-define(CONFIG_INVALID_KEY, {?MODULE, config_invalid}).

-spec init() -> ok.
init() ->
    lists:foreach(
        fun(Name) ->
            try emqx_metrics:new(Name) catch _:_ -> ok end
        end,
        ?COUNTERS
    ),
    ok.

-spec inc(atom()) -> ok.
inc(Name) -> inc(Name, 1).

-spec inc(atom(), integer()) -> ok.
-ifdef(AFORO_NO_EMQX).
%% Without EMQX (the test profile) counters live in a local ETS table so
%% the suites can assert on them.
-define(LOCAL, aforo_metering_local_counters).
inc(_Name, 0) -> ok;
inc(Name, N) ->
    ensure_local(),
    _ = ets:update_counter(?LOCAL, Name, N, {Name, 0}),
    ok.
val(Name) ->
    ensure_local(),
    case ets:lookup(?LOCAL, Name) of
        [{_, V}] -> V;
        [] -> 0
    end.
ensure_local() ->
    case ets:info(?LOCAL) of
        undefined ->
            %% Owned by a parked process so the table outlives the caller.
            Parent = self(),
            Pid = spawn(fun() ->
                try ets:new(?LOCAL, [named_table, public, set, {write_concurrency, true}]) of
                    _ -> Parent ! {self(), ready}, receive stop -> ok end
                catch error:badarg -> Parent ! {self(), ready}
                end
            end),
            receive {Pid, ready} -> ok after 1000 -> ok end;
        _ -> ok
    end.
-else.
inc(_Name, 0) -> ok;
inc(Name, N) ->
    try emqx_metrics:inc(Name, N) catch _:_ -> ok end.
val(Name) -> safe_value(Name).
-endif.

%% Persist circuit-breaker state as a numeric gauge: 0=closed, 1=half_open, 2=open.
%% Held in persistent_term so reads in the hot path (Prometheus scrape, dashboard)
%% are sub-microsecond and lock-free.
-spec set_circuit_state(closed | half_open | open) -> ok.
set_circuit_state(closed)    -> persistent_term:put(?CIRCUIT_STATE_KEY, 0), ok;
set_circuit_state(half_open) -> persistent_term:put(?CIRCUIT_STATE_KEY, 1), ok;
set_circuit_state(open)      -> persistent_term:put(?CIRCUIT_STATE_KEY, 2), ok;
set_circuit_state(_)         -> ok.

-spec circuit_state() -> 0 | 1 | 2.
circuit_state() ->
    persistent_term:get(?CIRCUIT_STATE_KEY, 0).

-spec set_config_invalid(boolean()) -> ok.
set_config_invalid(true)  -> persistent_term:put(?CONFIG_INVALID_KEY, 1), ok;
set_config_invalid(false) -> _ = persistent_term:erase(?CONFIG_INVALID_KEY), ok.

-spec config_invalid() -> 0 | 1.
config_invalid() -> persistent_term:get(?CONFIG_INVALID_KEY, 0).

-spec get_all() -> [{atom(), non_neg_integer()}].
get_all() ->
    Counters = [{Name, safe_value(Name)} || Name <- ?COUNTERS],
    [{'aforo.metering.circuit.state', circuit_state()},
     {'aforo.metering.config.invalid', config_invalid()} | Counters].

-ifdef(AFORO_NO_EMQX).
safe_value(Name) -> val(Name).
-else.
safe_value(Name) ->
    try emqx_metrics:val(Name) catch _:_ -> 0 end.
-endif.
