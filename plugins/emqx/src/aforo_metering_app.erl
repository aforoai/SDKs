%%%-------------------------------------------------------------------
%%% @doc OTP application entry point for the Aforo MQTT Metering plugin.
%%% Delegates to aforo_metering:load/0 on start and :unload/0 on stop.
%%% @end
%%%-------------------------------------------------------------------
-module(aforo_metering_app).
-behaviour(application).

-export([start/2, stop/1]).

start(_StartType, _StartArgs) ->
    {ok, Pid} = aforo_metering_sup:start_link(),
    ok = aforo_metering:load(),
    {ok, Pid}.

stop(_State) ->
    ok = aforo_metering:unload(),
    ok.
