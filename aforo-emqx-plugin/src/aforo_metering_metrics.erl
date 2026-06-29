%%%-------------------------------------------------------------------
%%% @doc
%%% Counter-based metrics for the Aforo MQTT Metering plugin.
%%%
%%% Uses EMQ X's built-in emqx_metrics facility (backed by atomic
%%% counters). Emits gauge/counter values that can be scraped via the
%%% EMQ X Prometheus endpoint at /api/v5/prometheus/stats.
%%%
%%% Counters:
%%%   aforo.metering.events.buffered          — events currently in ETS
%%%   aforo.metering.events.flushed           — events successfully shipped
%%%   aforo.metering.events.dropped           — events dropped after retry exhaustion
%%%   aforo.metering.flush.success            — successful ingestor POSTs
%%%   aforo.metering.flush.retry              — retry attempts
%%%   aforo.metering.flush.error              — terminal flush failures
%%%   aforo.metering.customer_lookup.hit      — cache hits in customer-id resolver
%%%   aforo.metering.customer_lookup.miss     — cache misses (resolver invoked)
%%%
%%% Gauges (persistent_term-backed, set/circuit_state/get_circuit_state):
%%%   aforo.metering.circuit.state            — 0 = closed, 1 = half_open, 2 = open
%%% @end
%%%-------------------------------------------------------------------
-module(aforo_metering_metrics).

-export([
    init/0,
    inc/1,
    inc/2,
    set_circuit_state/1,
    circuit_state/0,
    get_all/0
]).

-define(COUNTERS, [
    'aforo.metering.events.buffered',
    'aforo.metering.events.flushed',
    'aforo.metering.events.dropped',
    'aforo.metering.flush.success',
    'aforo.metering.flush.retry',
    'aforo.metering.flush.error',
    'aforo.metering.customer_lookup.hit',
    'aforo.metering.customer_lookup.miss'
]).

-define(CIRCUIT_STATE_KEY, {?MODULE, circuit_state}).

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
inc(Name, N) ->
    try emqx_metrics:inc(Name, N) catch _:_ -> ok end.

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

-spec get_all() -> [{atom(), non_neg_integer()}].
get_all() ->
    Counters = [{Name, safe_value(Name)} || Name <- ?COUNTERS],
    [{'aforo.metering.circuit.state', circuit_state()} | Counters].

safe_value(Name) ->
    try emqx_metrics:val(Name) catch _:_ -> 0 end.
