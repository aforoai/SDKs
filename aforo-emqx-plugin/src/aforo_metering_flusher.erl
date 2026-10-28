%%%-------------------------------------------------------------------
%%% @doc
%%% The one process that owns the outgoing event queue and talks to the
%%% ingestor.
%%%
%%% Before 2.0.0 the queue was a public ETS table every publishing
%%% process drained and re-inserted when it hit the size cap (concurrent
%%% callers each swapped and dropped), each event above `flush_count'
%%% spawned its own flush, and the interval timer flushed in parallel
%%% with those. Now:
%%%
%%%   * broker hooks only bump aggregation counters
%%%     (aforo_metering_aggregator) -- they never touch the queue;
%%%   * this gen_server closes finished windows once per
%%%     `flush_interval_ms', appends the events to its own bounded FIFO
%%%     (`max_buffer_size'; overflow evicts the OLDEST events and counts
%%%     them), and sends from it;
%%%   * exactly one request is in flight: a monitored sender process
%%%     runs aforo_metering_transport:send/2 for one batch and reports
%%%     back, so the gen_server stays responsive while a request is slow;
%%%   * after an outage the batch goes back to the front of the queue
%%%     with its idempotency keys and sending pauses for the breaker
%%%     cooldown: max(250 ms, random(0, min(5 min, 5 s * 2^n))). The next
%%%     successful send resets n;
%%%   * `drain/1' (plugin stop) closes every window, then keeps sending
%%%     until the queue is empty or the shutdown deadline passes; what is
%%%     left is counted as dropped;
%%%   * `reconfigure/0' (a config change while running) applies the new
%%%     settings in this process, between ticks: batch size, interval and
%%%     queue size; the aggregation settings (a changed window shape
%%%     closes the open windows at once); a paused delivery is retried at
%%%     once so a fixed API key or URL takes effect. Nothing queued is
%%%     dropped: a smaller `max_buffer_size' is reached by sending, not by
%%%     evicting.
%%% @end
%%%-------------------------------------------------------------------
-module(aforo_metering_flusher).
-behaviour(gen_server).

-include("aforo_metering_emqx.hrl").

-export([start_link/0, start_link/1, wake/0, flush/0, drain/1, status/0, reconfigure/0]).
-export([init/1, handle_call/3, handle_cast/2, handle_info/2, terminate/2]).
-export([cooldown_ms/2]).

-define(WAKE_FLAG, {?MODULE, wake_flag}).
-define(BREAKER_FLOOR_MS, 250).
-define(BREAKER_INITIAL_MS, 5000).
-define(BREAKER_MAX_MS, 300000).

-record(st, {
    q = queue:new(),
    len = 0 :: non_neg_integer(),
    %% Effective cap. Above target_max only after max_buffer_size was
    %% lowered with more than that queued; it then falls back to
    %% target_max as the queue drains (relax_cap/1), so nothing is evicted.
    max_len :: pos_integer(),
    target_max :: pos_integer(),
    batch :: pos_integer(),
    interval :: pos_integer(),
    inflight = undefined :: undefined | {pid(), reference(), [map()]},
    failures = 0 :: non_neg_integer(),
    open_until = undefined :: undefined | integer(),
    auth_logged = false :: boolean(),
    transport_opts = #{} :: map(),
    flush_waiters = [] :: [gen_server:from()]
}).

start_link() -> start_link(#{}).

%% TransportOpts override aforo_metering_transport defaults (tests).
start_link(TransportOpts) ->
    gen_server:start_link({local, ?MODULE}, ?MODULE, TransportOpts, []).

%% Hot path (only used without aggregation): wake the flusher once when
%% enough events are waiting. Waking an awake flusher is a no-op, and at
%% most one wake message is in its mailbox at a time.
-spec wake() -> ok.
wake() ->
    Flag = persistent_term:get(?WAKE_FLAG, undefined),
    case Flag =/= undefined andalso atomics:compare_exchange(Flag, 1, 0, 1) =:= ok of
        true ->
            case whereis(?MODULE) of
                undefined -> ok;
                Pid -> Pid ! wake, ok
            end;
        false -> ok
    end.

%% Close finished windows and send now, even with the breaker open (the
%% caller asked); waits for the attempt to finish.
-spec flush() -> ok.
flush() ->
    gen_server:call(?MODULE, flush, infinity).

-spec drain(non_neg_integer()) -> #{sent := non_neg_integer(), dropped := non_neg_integer()}.
drain(TimeoutMs) ->
    gen_server:call(?MODULE, {drain, TimeoutMs}, TimeoutMs + 5000).

-spec status() -> map().
status() ->
    gen_server:call(?MODULE, status, 2000).

%% Apply the current config snapshot (aforo_metering:on_config_changed/2).
-spec reconfigure() -> {ok, unchanged | reshaped}.
reconfigure() ->
    gen_server:call(?MODULE, reconfigure, 10000).

%%--------------------------------------------------------------------

init(TransportOpts) ->
    process_flag(trap_exit, true),
    Flag = atomics:new(1, []),
    persistent_term:put(?WAKE_FLAG, Flag),
    Max = aforo_metering_config:max_buffer_size(),
    St = #st{max_len = Max,
             target_max = Max,
             batch = aforo_metering_config:flush_count(),
             interval = aforo_metering_config:flush_interval_ms(),
             transport_opts = TransportOpts},
    erlang:send_after(St#st.interval, self(), tick),
    {ok, St}.

handle_call(status, _From, St) ->
    {reply, #{queue_depth => St#st.len,
              max_buffer_size => St#st.max_len,
              in_flight => St#st.inflight =/= undefined,
              in_flight_events => case St#st.inflight of
                                      {_, _, B} -> length(B);
                                      undefined -> 0
                                  end,
              circuit => circuit(St),
              consecutive_failures => St#st.failures}, St};
handle_call(flush, From, St0) ->
    St1 = close_windows(St0),
    St2 = St1#st{open_until = undefined},
    case St2#st.inflight =:= undefined andalso St2#st.len =:= 0 of
        true -> {reply, ok, St2};
        false -> {noreply, maybe_send(St2#st{flush_waiters = [From | St2#st.flush_waiters]})}
    end;
handle_call(reconfigure, _From, St0) ->
    Shape = aforo_metering_aggregator:reconfigure(),
    Target = aforo_metering_config:max_buffer_size(),
    St1 = relax_cap(St0#st{batch = aforo_metering_config:flush_count(),
                           interval = aforo_metering_config:flush_interval_ms(),
                           target_max = Target,
                           max_len = max(St0#st.max_len, Target)}),
    St2 = case Shape of
        reshaped -> close_open_windows(St1);
        unchanged -> St1
    end,
    %% A pause (breaker open) is cut short: the change may be the fix
    %% (new API key, URL or CA). The backoff count is kept, so a send
    %% that fails again pauses for longer.
    St3 = St2#st{open_until = undefined, auth_logged = false},
    {reply, {ok, Shape}, maybe_send(St3)};
handle_call({drain, TimeoutMs}, _From, St) ->
    Deadline = erlang:monotonic_time(millisecond) + TimeoutMs,
    {Reply, St1} = do_drain(St, Deadline),
    {reply, Reply, St1};
handle_call(_Req, _From, St) ->
    {reply, {error, unknown_call}, St}.

handle_cast(_Msg, St) ->
    {noreply, St}.

handle_info(tick, St0) ->
    St1 = maybe_send(close_windows(relax_cap(St0))),
    erlang:send_after(St1#st.interval, self(), tick),
    {noreply, St1};
handle_info(wake, St0) ->
    reset_wake(),
    {noreply, maybe_send(close_windows(St0))};
handle_info({sent, Pid, Result}, St = #st{inflight = {Pid, Mon, _}}) ->
    erlang:demonitor(Mon, [flush]),
    {noreply, after_send(apply_result(Result, St#st{inflight = undefined}))};
handle_info({'DOWN', Mon, process, Pid, Reason}, St = #st{inflight = {Pid, Mon, Batch}}) ->
    %% The sender crashed: nothing was confirmed, so the batch goes back.
    ?SLOG(error, #{msg => "aforo_metering sender crashed, batch re-queued", reason => Reason}),
    St1 = requeue_front(Batch, St#st{inflight = undefined}),
    {noreply, after_send(open_breaker(sender_crash, St1))};
handle_info(_Info, St) ->
    {noreply, St}.

%% The queue and the in-flight batch are process state: whatever is
%% still here is lost, so it is counted (after a normal drain it is 0).
%% Open aggregation windows live in tables the supervisor owns and
%% survive a restart of this process.
terminate(Reason, St) ->
    InFlight = case St#st.inflight of
        {Pid, _, Batch} -> exit(Pid, kill), length(Batch);
        undefined -> 0
    end,
    Lost = St#st.len + InFlight,
    case Lost of
        0 -> ok;
        _ ->
            aforo_metering_metrics:inc('aforo.metering.events.dropped', Lost),
            ?SLOG(error, #{msg => "aforo_metering flusher stopped with usage still queued",
                           reason => Reason, dropped => Lost})
    end,
    try persistent_term:erase(?WAKE_FLAG) catch _:_ -> ok end,
    ok.

%%--------------------------------------------------------------------
%% Queue
%%--------------------------------------------------------------------

%% Only as many closed windows as the queue has room for -- counting the
%% batch in flight, which comes back to the queue if it fails -- so a
%% failed send never pushes freshly closed events out. The rest stay in
%% the counter table until the next tick.
close_windows(St) ->
    {Events, _Unresolved} = aforo_metering_aggregator:close_windows(
                              erlang:system_time(millisecond), room(St)),
    enqueue(Events, St).

%% After a change of window shape: every started window, within the room.
close_open_windows(St) ->
    {Events, _Unresolved} = aforo_metering_aggregator:close_open_windows(
                              erlang:system_time(millisecond), room(St)),
    enqueue(Events, St).

room(St) -> max(0, St#st.max_len - St#st.len - inflight_len(St)).

inflight_len(#st{inflight = {_, _, Batch}}) -> length(Batch);
inflight_len(#st{inflight = undefined}) -> 0.

%% Bring a raised cap back down towards target_max, never below what is
%% held (queued + in flight).
relax_cap(St = #st{max_len = Max, target_max = Target}) when Max =< Target -> St;
relax_cap(St = #st{target_max = Target}) ->
    St#st{max_len = max(Target, St#st.len + inflight_len(St))}.

enqueue(Events, St) ->
    St1 = lists:foldl(fun(E, S) -> S#st{q = queue:in(E, S#st.q), len = S#st.len + 1} end,
                      St, Events),
    enforce_cap(St1).

requeue_front(Events, St) ->
    Q = lists:foldr(fun(E, Acc) -> queue:in_r(E, Acc) end, St#st.q, Events),
    enforce_cap(St#st{q = Q, len = St#st.len + length(Events)}).

%% Evict the oldest events over the cap; counted, logged at most once a
%% minute.
enforce_cap(St = #st{len = Len, max_len = Max}) when Len =< Max -> St;
enforce_cap(St = #st{len = Len, max_len = Max}) ->
    N = Len - Max,
    {_Dropped, Q} = queue:split(N, St#st.q),
    aforo_metering_metrics:inc('aforo.metering.events.dropped', N),
    log_overflow(N, Max),
    St#st{q = Q, len = Max}.

log_overflow(N, Max) ->
    Now = erlang:monotonic_time(second),
    case Now - persistent_term:get({?MODULE, last_overflow_log}, Now - 61) >= 60 of
        true ->
            persistent_term:put({?MODULE, last_overflow_log}, Now),
            ?SLOG(warning, #{msg => "aforo_metering queue full, oldest events dropped",
                             dropped => N, max_buffer_size => Max});
        false -> ok
    end.

take(N, St) ->
    Take = min(N, St#st.len),
    {Q1, Q2} = queue:split(Take, St#st.q),
    {queue:to_list(Q1), St#st{q = Q2, len = St#st.len - Take}}.

%%--------------------------------------------------------------------
%% Sending (one request in flight)
%%--------------------------------------------------------------------

maybe_send(St = #st{inflight = {_, _, _}}) -> St;
maybe_send(St = #st{len = 0}) -> reply_waiters(St);
maybe_send(St) ->
    case breaker_open(St) of
        true -> reply_waiters(St);
        false ->
            {Batch, St1} = take(St#st.batch, St),
            Self = self(),
            Opts = St#st.transport_opts,
            {Pid, Mon} = spawn_monitor(fun() ->
                Self ! {sent, self(), aforo_metering_transport:send(Batch, Opts)}
            end),
            St1#st{inflight = {Pid, Mon, Batch}}
    end.

after_send(St0) ->
    St = reply_waiters(relax_cap(St0)),
    case St#st.open_until of
        undefined when St#st.len > 0 -> maybe_send(St);
        _ -> St
    end.

%% flush/0 callers are answered once the attempt they asked for is done
%% (nothing to send, a send completed, or delivery is paused).
reply_waiters(St = #st{flush_waiters = []}) -> St;
reply_waiters(St = #st{inflight = {_, _, _}}) -> St;
reply_waiters(St) ->
    [gen_server:reply(W, ok) || W <- St#st.flush_waiters],
    St#st{flush_waiters = []}.

apply_result(#{sent := Sent, rejected := Rejected, requeue := Requeue, outage := Outage}, St) ->
    aforo_metering_metrics:inc('aforo.metering.events.flushed', Sent),
    case Rejected of
        [] -> ok;
        _ ->
            aforo_metering_metrics:inc('aforo.metering.events.rejected', length(Rejected)),
            aforo_metering_metrics:inc('aforo.metering.events.dropped', length(Rejected))
    end,
    case Outage of
        undefined ->
            St1 = requeue_front(Requeue, St),
            close_breaker(St1);
        Reason ->
            aforo_metering_metrics:inc('aforo.metering.flush.error', 1),
            St1 = requeue_front(Requeue, St),
            open_breaker(Reason, St1)
    end.

%%--------------------------------------------------------------------
%% Breaker
%%--------------------------------------------------------------------

breaker_open(#st{open_until = undefined}) -> false;
breaker_open(#st{open_until = T}) -> erlang:monotonic_time(millisecond) < T.

circuit(#st{open_until = undefined}) -> closed;
circuit(St) ->
    case breaker_open(St) of
        true -> open;
        false -> half_open
    end.

open_breaker(Reason, St) ->
    N = St#st.failures,
    Cooldown = cooldown_ms(N, fun(Max) -> rand:uniform(Max + 1) - 1 end),
    aforo_metering_metrics:set_circuit_state(open),
    St1 = St#st{failures = N + 1,
                open_until = erlang:monotonic_time(millisecond) + Cooldown},
    case Reason of
        {auth, Code} when not St#st.auth_logged ->
            ?SLOG(error, #{msg => "aforo_metering ingestor refused the API key; usage is kept "
                                  "and re-sent once the key is fixed",
                           status => Code, queued => St1#st.len}),
            St1#st{auth_logged = true};
        {redirect, Code, Host} when not St#st.auth_logged ->
            ?SLOG(error, #{msg => "aforo_metering ingestor answered with a redirect, which is "
                                  "never followed; fix ingestor_url", status => Code,
                           location_host => Host, queued => St1#st.len}),
            St1#st{auth_logged = true};
        _ ->
            ?SLOG(warning, #{msg => "aforo_metering delivery paused after a failed send",
                             reason => Reason, cooldown_ms => Cooldown, queued => St1#st.len}),
            St1
    end.

close_breaker(St = #st{failures = 0, open_until = undefined}) -> St;
close_breaker(St) ->
    aforo_metering_metrics:set_circuit_state(closed),
    St#st{failures = 0, open_until = undefined, auth_logged = false}.

%% max(250 ms, random(0, min(5 min, 5 s * 2^n)))
-spec cooldown_ms(non_neg_integer(), fun((non_neg_integer()) -> non_neg_integer())) ->
    non_neg_integer().
cooldown_ms(N, Rand) ->
    Ceiling = min(?BREAKER_MAX_MS, ?BREAKER_INITIAL_MS * (1 bsl min(N, 16))),
    max(?BREAKER_FLOOR_MS, Rand(Ceiling)).

%%--------------------------------------------------------------------
%% Shutdown drain
%%--------------------------------------------------------------------

do_drain(St0, Deadline) ->
    {Events, Unresolved} = aforo_metering_aggregator:close_all(),
    St1 = enqueue(Events, St0),
    St2 = wait_inflight(St1, Deadline),
    {Sent, St3} = drain_loop(St2, Deadline, 0, 0),
    Left = St3#st.len,
    case Left of
        0 -> ok;
        _ ->
            aforo_metering_metrics:inc('aforo.metering.events.dropped', Left),
            ?SLOG(warning, #{msg => "aforo_metering shutdown deadline passed, events dropped",
                             dropped => Left})
    end,
    St4 = reply_all_waiters(St3#st{q = queue:new(), len = 0}),
    {#{sent => Sent, dropped => Left + Unresolved}, St4}.

wait_inflight(St = #st{inflight = undefined}, _Deadline) -> St;
wait_inflight(St = #st{inflight = {Pid, Mon, Batch}}, Deadline) ->
    Wait = max(0, Deadline - erlang:monotonic_time(millisecond)),
    receive
        {sent, Pid, Result} ->
            erlang:demonitor(Mon, [flush]),
            apply_result(Result, St#st{inflight = undefined});
        {'DOWN', Mon, process, Pid, _} ->
            requeue_front(Batch, St#st{inflight = undefined})
    after Wait ->
        %% Cut off at the deadline: the request may or may not have
        %% arrived; its events are counted once, as dropped at shutdown.
        exit(Pid, kill),
        erlang:demonitor(Mon, [flush]),
        aforo_metering_metrics:inc('aforo.metering.events.dropped', length(Batch)),
        St#st{inflight = undefined}
    end.

drain_loop(St = #st{len = 0}, _Deadline, Sent, _Attempt) -> {Sent, St};
drain_loop(St, Deadline, Sent, Attempt) ->
    case Deadline - erlang:monotonic_time(millisecond) of
        Left when Left =< 0 -> {Sent, St};
        Left ->
            {Batch, St1} = take(St#st.batch, St),
            Opts = (St#st.transport_opts)#{deadline => Deadline},
            case send_bounded(Batch, Opts, Left) of
                {ok, R} ->
                    St2 = apply_result(R, St1),
                    S = maps:get(sent, R),
                    case maps:get(outage, R) of
                        undefined -> drain_loop(St2, Deadline, Sent + S, 0);
                        _ ->
                            %% Keep trying, with jittered backoff, until the deadline.
                            Pause = aforo_metering_transport:backoff_ms(
                                      Attempt, undefined,
                                      #{rand => fun(M) -> rand:uniform(M + 1) - 1 end}),
                            timer:sleep(max(0, min(Pause, Deadline - erlang:monotonic_time(millisecond)))),
                            drain_loop(St2#st{open_until = undefined}, Deadline, Sent + S, Attempt + 1)
                    end;
                timeout ->
                    %% Cut off at the deadline: counted once, as dropped.
                    aforo_metering_metrics:inc('aforo.metering.events.dropped', length(Batch)),
                    {Sent, St1}
            end
    end.

%% Run one send in its own process so the deadline holds even if the
%% HTTP client does not honour its own timeout.
send_bounded(Batch, Opts, Left) ->
    Self = self(),
    {Pid, Mon} = spawn_monitor(fun() ->
        Self ! {drain_sent, self(), aforo_metering_transport:send(Batch, Opts)}
    end),
    receive
        {drain_sent, Pid, R} -> erlang:demonitor(Mon, [flush]), {ok, R};
        {'DOWN', Mon, process, Pid, _} ->
            {ok, #{sent => 0, rejected => [], requeue => Batch, outage => sender_crash}}
    after Left ->
        exit(Pid, kill),
        erlang:demonitor(Mon, [flush]),
        receive {drain_sent, Pid, _} -> ok after 0 -> ok end,
        timeout
    end.

reply_all_waiters(St) ->
    [gen_server:reply(W, ok) || W <- St#st.flush_waiters],
    St#st{flush_waiters = []}.

reset_wake() ->
    case persistent_term:get(?WAKE_FLAG, undefined) of
        undefined -> ok;
        Flag -> atomics:put(Flag, 1, 0)
    end.
