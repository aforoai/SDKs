%%%-------------------------------------------------------------------
%%% @doc OTP application entry point for the Aforo MQTT Metering plugin.
%%%
%%% start/2 reads the plugin config from EMQX and validates it first and refuses to start on a
%%% setting that would bill the wrong customer or send the API key over
%%% an unverified connection. prep_stop/1 unhooks and drains the queue
%%% (bounded by shutdown_timeout_ms) while the flusher is still running;
%%% OTP calls it before the supervision tree is stopped.
%%% @end
%%%-------------------------------------------------------------------
-module(aforo_metering_app).
-behaviour(application).

%% Marks the module EMQX calls the plugin callbacks on (`<name>_app').
-emqx_plugin(?MODULE).

-export([start/2, prep_stop/1, stop/1]).
-export([on_config_changed/2, on_health_check/1]).

start(_StartType, _StartArgs) ->
    %% The plugin config lives in emqx_plugins, not emqx_conf; read it
    %% before validating (aforo_metering_config:load/0).
    ok = aforo_metering_config:load(),
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

%% EMQX 5.8+: the plugin config was changed (Dashboard / REST API).
on_config_changed(OldConfig, NewConfig) ->
    aforo_metering:on_config_changed(OldConfig, NewConfig).

%% EMQX 5.9+: plugin info requested.
on_health_check(Options) ->
    aforo_metering:on_health_check(Options).
