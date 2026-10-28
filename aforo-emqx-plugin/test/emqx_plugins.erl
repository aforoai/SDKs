%%%-------------------------------------------------------------------
%%% Test stand-in for EMQX's emqx_plugins module (test profile only;
%%% never packaged). emqx_plugin_helper:get_config/1 calls
%%% emqx_plugins:get_config/1; a suite sets what it returns with
%%% set_reply/1 and reads the NameVsn it was called with from calls/0.
%%% The official plugin template does not use meck, so neither do we.
%%%-------------------------------------------------------------------
-module(emqx_plugins).

-export([get_config/1, set_reply/1, clear/0, calls/0]).

-define(REPLY, {?MODULE, reply}).
-define(CALLS, {?MODULE, calls}).

%% Reply: a term to return, or {raise, Class, Reason}.
set_reply(Reply) ->
    persistent_term:put(?REPLY, Reply),
    persistent_term:put(?CALLS, []),
    ok.

clear() ->
    _ = persistent_term:erase(?REPLY),
    _ = persistent_term:erase(?CALLS),
    ok.

calls() -> lists:reverse(persistent_term:get(?CALLS, [])).

get_config(NameVsn) ->
    persistent_term:put(?CALLS, [NameVsn | persistent_term:get(?CALLS, [])]),
    case persistent_term:get(?REPLY, undefined) of
        undefined -> erlang:error(undef);
        {raise, C, R} -> erlang:raise(C, R, []);
        Reply -> Reply
    end.
