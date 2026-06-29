%%%-------------------------------------------------------------------
%%% @doc Supervisor for the Aforo MQTT Metering plugin.
%%% Currently manages no child processes — the flush timer is a
%%% timer:apply_interval managed directly by the plugin module.
%%% @end
%%%-------------------------------------------------------------------
-module(aforo_metering_sup).
-behaviour(supervisor).

-export([start_link/0, init/1]).

start_link() ->
    supervisor:start_link({local, ?MODULE}, ?MODULE, []).

init([]) ->
    SupFlags = #{strategy => one_for_one, intensity => 10, period => 60},
    {ok, {SupFlags, []}}.
