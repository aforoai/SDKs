%%%-------------------------------------------------------------------
%%% @doc
%%% Asynchronous customer lookups for the http resolver.
%%%
%%% Before 2.0.0 the http lookup ran inside the MQTT client's own process
%%% with a 5 s timeout, so a slow mapping service stalled CONNECT and
%%% every message of that client. Now hooks only `cast' a request here
%%% and keep going; events recorded meanwhile are held under the
%%% clientid and attributed when the answer arrives (see
%%% aforo_metering_aggregator).
%%%
%%% One gen_server, a bounded FIFO (`customer_resolver_http_queue_size'),
%%% at most `customer_resolver_http_workers' lookups in flight, each a
%%% monitored process with its own deadline
%%% (`customer_resolver_http_timeout_ms'), killed if it outlives it. A
%%% request for a clientid already queued replaces the earlier one's Ref
%%% instead of adding a second lookup (a request for one already running
%%% is queued; the running answer is then discarded as stale). When the
%%% queue is full the request is refused, counted
%%% (aforo.metering.resolver.dropped), and the client keeps its previous
%%% customer if it had one, else a miss is cached for the negative TTL.
%%%
%%% The cache table itself is owned by aforo_metering_sup; this server
%%% sweeps expired rows every 30 s.
%%% @end
%%%-------------------------------------------------------------------
-module(aforo_metering_resolver_pool).
-behaviour(gen_server).

-include("aforo_metering_emqx.hrl").

-export([start_link/0, request/4, stats/0]).
-export([init/1, handle_call/3, handle_cast/2, handle_info/2, terminate/2]).

-define(SWEEP_MS, 30000).

-record(st, {
    queue = queue:new(),
    queued = #{} :: #{binary() => {{binary(), map()}, reference()}},  %% ClientId => {Inputs, Ref}
    running = #{} :: #{pid() => {reference(), binary(), binary(), reference()}}, %% Worker => {MonRef, Tenant, ClientId, Ref}
    max_workers :: pos_integer(),
    max_queue :: pos_integer()
}).

start_link() ->
    gen_server:start_link({local, ?MODULE}, ?MODULE, [], []).

-spec request(binary(), binary(), {binary(), map()}, reference()) -> ok.
request(Tenant, ClientId, Inputs, Ref) ->
    case whereis(?MODULE) of
        undefined ->
            %% Pool not running (plugin stopping or restarting).
            aforo_metering_cache:refuse_pending(Tenant, ClientId, Ref);
        Pid ->
            gen_server:cast(Pid, {request, Tenant, ClientId, Inputs, Ref})
    end.

stats() ->
    gen_server:call(?MODULE, stats).

init([]) ->
    process_flag(trap_exit, true),
    erlang:send_after(?SWEEP_MS, self(), sweep),
    {ok, #st{max_workers = aforo_metering_config:http_resolver_workers(),
             max_queue = aforo_metering_config:http_resolver_queue_size()}}.

handle_call(stats, _From, St) ->
    {reply, #{queued => maps:size(St#st.queued), running => maps:size(St#st.running)}, St};
handle_call(_Req, _From, St) ->
    {reply, {error, unknown_call}, St}.

handle_cast({request, Tenant, ClientId, Inputs, Ref}, St) ->
    St1 = case maps:is_key(ClientId, St#st.queued) of
        true ->
            %% Already queued: the newest connection's Ref wins.
            St#st{queued = maps:put(ClientId, {Inputs, Ref}, St#st.queued)};
        false ->
            case maps:size(St#st.queued) >= St#st.max_queue of
                true ->
                    aforo_metering_metrics:inc('aforo.metering.resolver.dropped', 1),
                    aforo_metering_cache:refuse_pending(Tenant, ClientId, Ref),
                    St;
                false ->
                    St#st{queue = queue:in({Tenant, ClientId}, St#st.queue),
                          queued = maps:put(ClientId, {Inputs, Ref}, St#st.queued)}
            end
    end,
    {noreply, dispatch(St1)};
handle_cast(_Msg, St) ->
    {noreply, St}.

handle_info({lookup_done, Pid, Result}, St) ->
    case maps:take(Pid, St#st.running) of
        {{MonRef, Tenant, ClientId, Ref}, Running} ->
            erlang:demonitor(MonRef, [flush]),
            _ = aforo_metering_cache:complete_pending(Tenant, ClientId, Ref, Result),
            {noreply, dispatch(St#st{running = Running})};
        error ->
            {noreply, St}
    end;
handle_info({'DOWN', _MonRef, process, Pid, Reason}, St) ->
    case maps:take(Pid, St#st.running) of
        {{_, Tenant, ClientId, Ref}, Running} ->
            ?SLOG(warning, #{msg => "aforo_metering customer lookup crashed", reason => Reason}),
            _ = aforo_metering_cache:complete_pending(Tenant, ClientId, Ref, undefined),
            {noreply, dispatch(St#st{running = Running})};
        error ->
            {noreply, St}
    end;
handle_info({kill_worker, Pid}, St) ->
    case maps:is_key(Pid, St#st.running) of
        true -> exit(Pid, kill);   %% the DOWN handler records the miss
        false -> ok
    end,
    {noreply, St};
handle_info(sweep, St) ->
    _ = aforo_metering_cache:sweep(),
    erlang:send_after(?SWEEP_MS, self(), sweep),
    {noreply, St};
handle_info(_Info, St) ->
    {noreply, St}.

terminate(_Reason, _St) ->
    ok.

%% Start lookups while there are free worker slots and queued requests.
dispatch(St = #st{running = R, max_workers = Max}) when map_size(R) >= Max ->
    St;
dispatch(St) ->
    case queue:out(St#st.queue) of
        {empty, _} -> St;
        {{value, {Tenant, ClientId}}, Q} ->
            case maps:take(ClientId, St#st.queued) of
                {{Inputs, Ref}, Queued} ->
                    Self = self(),
                    {Pid, MonRef} = spawn_monitor(fun() ->
                        Result = try aforo_metering_customer_resolver:http_lookup(ClientId, Inputs)
                                 catch C:E ->
                                     ?SLOG(warning, #{msg => "aforo_metering customer lookup failed",
                                                      class => C, reason => E}),
                                     undefined
                                 end,
                        Self ! {lookup_done, self(), Result}
                    end),
                    %% Hard stop in case the HTTP client overruns its deadline.
                    erlang:send_after(aforo_metering_config:http_resolver_timeout_ms()
                                      + aforo_metering_config:connect_timeout_ms() + 1000,
                                      self(), {kill_worker, Pid}),
                    dispatch(St#st{queue = Q, queued = Queued,
                                   running = maps:put(Pid, {MonRef, Tenant, ClientId, Ref},
                                                      St#st.running)});
                error ->
                    dispatch(St#st{queue = Q})
            end
    end.
