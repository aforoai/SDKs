%%%-------------------------------------------------------------------
%%% EMQX headers.
%%%
%%% Taken from emqx_plugin_helper (the dependency the official EMQX
%%% plugin template uses), which vendors the EMQX headers a plugin needs:
%%%   * #message{}  -- emqx_message.hrl (via emqx.hrl);
%%%   * ?HP_LOWEST  -- emqx_hooks.hrl;
%%%   * ?SLOG/2     -- logger.hrl (forwards to OTP logger).
%%% The headers are plain Erlang, so the plugin compiles, and its eunit
%%% suites run, on Erlang/OTP alone -- no EMQX source tree.
%%%-------------------------------------------------------------------
-ifndef(AFORO_METERING_EMQX_HRL).
-define(AFORO_METERING_EMQX_HRL, true).

-include_lib("emqx_plugin_helper/include/emqx.hrl").
-include_lib("emqx_plugin_helper/include/emqx_hooks.hrl").
-include_lib("emqx_plugin_helper/include/logger.hrl").

-endif.
