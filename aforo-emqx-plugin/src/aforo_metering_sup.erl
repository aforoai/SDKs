%%%-------------------------------------------------------------------
%%% @doc Supervisor for the Aforo MQTT Metering plugin.
%%%
%%% Children:
%%%   aforo_metering_resolver_pool -- async http customer lookups; sweeps
%%%                                   the customer cache
%%%   aforo_metering_flusher       -- owns the outgoing queue, the one
%%%                                   in-flight request and the breaker
%%% The supervisor itself owns the ETS tables (customer cache, aggregation
%%% counters). Everything starts before aforo_metering:load/0 adds the
%%% broker hooks.
%%% @end
%%%-------------------------------------------------------------------
-module(aforo_metering_sup).
-behaviour(supervisor).

-export([start_link/0, init/1]).

start_link() ->
    supervisor:start_link({local, ?MODULE}, ?MODULE, []).

init([]) ->
    %% The tables are owned by this supervisor, which lives as long as the
    %% application: a crash of any worker loses neither the customer cache
    %% nor the open aggregation windows.
    ok = aforo_metering_cache:init(),
    ok = aforo_metering_aggregator:init(),
    SupFlags = #{strategy => one_for_one, intensity => 10, period => 60},
    Children = [
        #{id => aforo_metering_resolver_pool,
          start => {aforo_metering_resolver_pool, start_link, []},
          restart => permanent, shutdown => 5000, type => worker},
        #{id => aforo_metering_flusher,
          start => {aforo_metering_flusher, start_link, []},
          %% Drain runs in prep_stop, before this shutdown.
          restart => permanent, shutdown => 5000, type => worker}
    ],
    {ok, {SupFlags, Children}}.
