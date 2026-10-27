%%%-------------------------------------------------------------------
%%% EMQX headers, or stand-ins when building without EMQX.
%%%
%%% Inside an EMQX build the real headers are used. The `test' profile
%%% defines AFORO_NO_EMQX so the eunit suites compile and run on a plain
%%% Erlang/OTP install with no EMQX source tree. The stand-ins copy the
%%% shapes the plugin relies on:
%%%   * #message{} -- field names and defaults from
%%%     emqx/apps/emqx_utils/include/emqx_message.hrl (EMQX master,
%%%     read 2026-10-27);
%%%   * ?HP_LOWEST -- 0 in emqx/apps/emqx/include/emqx_hooks.hrl;
%%%   * ?SLOG(Level, Map) -- forwarded to OTP logger.
%%% Nothing in the plugin depends on any other EMQX header content.
%%% The non-test branch includes exactly what the plugin included before
%%% (emqx.hrl + logger.hrl).
%%%-------------------------------------------------------------------
-ifdef(AFORO_NO_EMQX).

-record(message, {
    id :: binary() | undefined,
    qos = 0,
    from :: atom() | binary() | undefined,
    flags = #{},
    headers = #{},
    topic :: binary() | undefined,
    payload :: iodata() | undefined,
    timestamp :: integer() | undefined,
    extra = #{} :: term()
}).

-define(HP_LOWEST, 0).
-define(SLOG(Level, Data), logger:log(Level, Data)).

-else.

-include_lib("emqx/include/emqx.hrl").
-include_lib("emqx/include/logger.hrl").

-endif.
