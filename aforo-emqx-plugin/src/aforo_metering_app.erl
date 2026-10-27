%%%-------------------------------------------------------------------
%%% @doc OTP application entry point for the Aforo MQTT Metering plugin.
%%%
%%% start/2 validates the configuration first and refuses to start on a
%%% setting that would bill the wrong customer or send the API key over
%%% an unverified connection. prep_stop/1 unhooks and drains the queue
%%% (bounded by shutdown_timeout_ms) while the flusher is still running;
%%% OTP calls it before the supervision tree is stopped.
%%% @end
%%%-------------------------------------------------------------------
-module(aforo_metering_app).
-behaviour(application).

-export([start/2, prep_stop/1, stop/1]).

start(_StartType, _StartArgs) ->
    case aforo_metering:prepare() of
        ok ->
            {ok, Pid} = aforo_metering_sup:start_link(),
            ok = aforo_metering:load(),
            {ok, Pid};
        {error, _} = Err ->
            Err
    end.

prep_stop(State) ->
    _ = aforo_metering:unload(),
    State.

stop(_State) ->
    aforo_metering:cleanup(),
    ok.
