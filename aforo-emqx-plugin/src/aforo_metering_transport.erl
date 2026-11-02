%%%-------------------------------------------------------------------
%%% @doc
%%% Delivery of usage events to the Aforo ingestor
%%% (POST /v1/ingest/batch).
%%%
%%% Follows aforo-metering-sdks/contract/TRANSPORT-SPEC.md, so the broker
%%% plugin behaves like the SDKs:
%%%
%%%   * at most `flush_count' (<= 1000) events per request, and a batch
%%%     whose JSON body would exceed 4 MiB is split;
%%%   * retries on network errors, timeouts, 408, 429 and every 5xx, with
%%%     full-jitter backoff (base 500 ms, cap 30 s) and Retry-After
%%%     honoured in both forms (capped at 60 s), at most `max_retries'
%%%     times;
%%%   * 2xx with errors[]: retryable events are re-sent after the backoff
%%%     (same keys), the rest are rejected;
%%%   * 413 halves the batch; a single event that still gets 413 is
%%%     rejected;
%%%   * 401, 403 and any 3xx are outages, not drops (a fixed key or URL
%%%     must not lose the queued usage); redirects are never followed;
%%%   * other 4xx reject the batch;
%%%   * everything runs against one deadline (shutdown uses it to stay
%%%     bounded): each request gets min(timeout, time left) and no sleep
%%%     runs past it.
%%%
%%% The caller (aforo_metering_flusher) gets back what was sent, what was
%%% rejected and what must go back to the front of the queue. Sleep,
%%% random source and the HTTP call are injectable for tests.
%%% @end
%%%-------------------------------------------------------------------
-module(aforo_metering_transport).

-include("aforo_metering_emqx.hrl").

-export([
    send/2,
    default_opts/0,
    classify/1,
    parse_retry_after/2,
    backoff_ms/3,
    split_by_size/2,
    chunk/2
]).

-define(BASE_MS, 500).
-define(MAX_DELAY_MS, 30000).
-define(RETRY_AFTER_MAX_MS, 60000).
-define(TARGET_BODY_BYTES, 4194304).
-define(USER_AGENT, "aforo-emqx-plugin/2.0.3").

-type result() :: #{sent := non_neg_integer(),
                    rejected := [map()],
                    requeue := [map()],
                    outage := undefined | term()}.

-spec default_opts() -> map().
default_opts() ->
    #{url => aforo_metering_config:ingestor_url(),
      api_key => aforo_metering_config:api_key(),
      tenant => aforo_metering_config:tenant_id(),
      batch_size => aforo_metering_config:flush_count(),
      timeout_ms => aforo_metering_config:request_timeout_ms(),
      max_retries => aforo_metering_config:max_retries(),
      deadline => infinity,
      sleep => fun timer:sleep/1,
      rand => fun(N) -> rand:uniform(N + 1) - 1 end,
      http => fun aforo_metering_http:request_post/4}.

%% Send Events (oldest first). Stops at the first outage: that batch and
%% every later one are returned in `requeue', in order.
-spec send([map()], map()) -> result().
send(Events, Opts0) ->
    Opts = maps:merge(default_opts_lazy(Opts0), Opts0),
    Batches = lists:append([split_by_size(B, ?TARGET_BODY_BYTES)
                            || B <- chunk(Events, maps:get(batch_size, Opts))]),
    send_batches(Batches, Opts, empty()).

%% Only build the config-backed defaults the caller did not pass (tests
%% pass everything and never read the config snapshot).
default_opts_lazy(Opts) ->
    Needed = [url, api_key, tenant, batch_size, timeout_ms, max_retries, deadline,
              sleep, rand, http],
    case lists:all(fun(K) -> maps:is_key(K, Opts) end, Needed) of
        true -> #{};
        false -> default_opts()
    end.

empty() -> #{sent => 0, rejected => [], requeue => [], outage => undefined}.

send_batches([], _Opts, Acc) -> Acc;
send_batches([Batch | Rest], Opts, Acc) ->
    Acc1 = merge(Acc, send_batch(Batch, Opts, 0)),
    case maps:get(outage, Acc1) of
        undefined -> send_batches(Rest, Opts, Acc1);
        _ -> Acc1#{requeue := maps:get(requeue, Acc1) ++ lists:append(Rest)}
    end.

merge(A, B) ->
    #{sent => maps:get(sent, A) + maps:get(sent, B),
      rejected => maps:get(rejected, A) ++ maps:get(rejected, B),
      requeue => maps:get(requeue, A) ++ maps:get(requeue, B),
      outage => case maps:get(outage, A) of undefined -> maps:get(outage, B); O -> O end}.

outage(Batch, Reason) -> #{sent => 0, rejected => [], requeue => Batch, outage => Reason}.

send_batch([], _Opts, _Attempt) -> empty();
send_batch(Batch, Opts, Attempt) ->
    case time_left(Opts) of
        Left when Left =< 0 -> outage(Batch, deadline);
        Left ->
            Timeout = min(maps:get(timeout_ms, Opts), Left),
            Body = jsone:encode(#{<<"events">> => Batch}),
            Headers = [{"X-API-Key", to_list(maps:get(api_key, Opts))},
                       {"X-Tenant-Id", to_list(maps:get(tenant, Opts))},
                       {"User-Agent", ?USER_AGENT}],
            Http = maps:get(http, Opts),
            Resp = Http(maps:get(url, Opts), Headers, Body, Timeout),
            handle(classify(Resp), Batch, Opts, Attempt)
    end.

handle({ok, RespBody}, Batch, Opts, Attempt) ->
    aforo_metering_metrics:inc('aforo.metering.flush.success', 1),
    {Rejected, Retryable} = per_event_errors(RespBody, Batch),
    Sent = length(Batch) - length(Rejected) - length(Retryable),
    Base = #{sent => Sent, rejected => Rejected, requeue => [], outage => undefined},
    case Retryable of
        [] -> Base;
        _ ->
            MaxRetries = maps:get(max_retries, Opts),
            case Attempt < MaxRetries andalso pause(backoff_ms(Attempt, undefined, Opts), Opts) of
                true -> merge(Base, send_batch(Retryable, Opts, Attempt + 1));
                false -> merge(Base, outage(Retryable, per_event_retry_exhausted))
            end
    end;
handle(too_large, [Single], _Opts, _Attempt) ->
    #{sent => 0, rejected => [Single], requeue => [], outage => undefined};
handle(too_large, Batch, Opts, _Attempt) ->
    {A, B} = lists:split(length(Batch) div 2, Batch),
    R1 = send_batch(A, Opts, 0),
    case maps:get(outage, R1) of
        undefined -> merge(R1, send_batch(B, Opts, 0));
        _ -> R1#{requeue := maps:get(requeue, R1) ++ B}
    end;
handle({outage, Reason}, Batch, _Opts, _Attempt) ->
    outage(Batch, Reason);
handle({rejected, Code, Body}, Batch, _Opts, _Attempt) ->
    %% Same bytes, same judgement: a 4xx is not retried. Logged with the
    %% response so a dropped batch says why (never the API key).
    ?SLOG(error, #{msg => "aforo_metering ingestor rejected batch, dropping it",
                   status => Code, dropped => length(Batch), response => truncate(Body, 500)}),
    #{sent => 0, rejected => Batch, requeue => [], outage => undefined};
handle({transient, Reason, RetryAfterMs}, Batch, Opts, Attempt) ->
    case Attempt < maps:get(max_retries, Opts) andalso
         pause(backoff_ms(Attempt, RetryAfterMs, Opts), Opts) of
        true ->
            aforo_metering_metrics:inc('aforo.metering.flush.retry', 1),
            send_batch(Batch, Opts, Attempt + 1);
        false -> outage(Batch, Reason)
    end.

%% Sleep unless that would pass the deadline. true = slept, retry.
pause(Ms, Opts) ->
    case time_left(Opts) of
        infinity -> (maps:get(sleep, Opts))(Ms), true;
        Left when Ms < Left -> (maps:get(sleep, Opts))(Ms), true;
        _ -> false
    end.

time_left(Opts) ->
    case maps:get(deadline, Opts) of
        infinity -> infinity;
        D -> D - erlang:monotonic_time(millisecond)
    end.

%% delay = random(0, min(30 s, 500 ms * 2^attempt)); with Retry-After:
%% max(retryAfter, delay), capped at 60 s.
-spec backoff_ms(non_neg_integer(), undefined | non_neg_integer(), map()) -> non_neg_integer().
backoff_ms(Attempt, RetryAfterMs, Opts) ->
    Ceiling = min(?MAX_DELAY_MS, ?BASE_MS * (1 bsl min(Attempt, 16))),
    Jittered = (maps:get(rand, Opts))(Ceiling),
    case RetryAfterMs of
        undefined -> Jittered;
        RA -> min(?RETRY_AFTER_MAX_MS, max(RA, Jittered))
    end.

%%--------------------------------------------------------------------
%% Response classification
%%--------------------------------------------------------------------

-spec classify(term()) ->
    {ok, binary()} | too_large | {outage, term()} | {rejected, integer(), binary()} |
    {transient, term(), undefined | non_neg_integer()}.
classify({ok, {{_, Code, _}, _Headers, Body}}) when Code >= 200, Code < 300 ->
    {ok, Body};
classify({ok, {{_, Code, _}, Headers, _}}) when Code >= 300, Code < 400 ->
    {outage, {redirect, Code, location_host(Headers)}};
classify({ok, {{_, Code, _}, _, _}}) when Code =:= 401; Code =:= 403 ->
    {outage, {auth, Code}};
classify({ok, {{_, 413, _}, _, _}}) ->
    too_large;
classify({ok, {{_, Code, _}, Headers, _}}) when Code =:= 408; Code =:= 429; Code >= 500 ->
    {transient, {http_status, Code}, parse_retry_after(Headers, erlang:system_time(second))};
classify({ok, {{_, Code, _}, _, Body}}) ->
    {rejected, Code, Body};
classify({error, Reason}) ->
    {transient, Reason, undefined};
classify(Other) ->
    {transient, Other, undefined}.

location_host(Headers) ->
    case header("location", Headers) of
        undefined -> undefined;
        Loc ->
            case uri_string:parse(unicode:characters_to_binary(Loc)) of
                #{host := H} -> H;
                _ -> undefined
            end
    end.

%% Retry-After as delta-seconds (may be fractional) or an HTTP-date. A
%% date in the past means 0; anything unreadable is ignored.
-spec parse_retry_after(list(), integer()) -> undefined | non_neg_integer().
parse_retry_after(Headers, NowSec) ->
    case header("retry-after", Headers) of
        undefined -> undefined;
        V0 ->
            V = string:trim(V0),
            case string:to_float(V) of
                {F, ""} when F >= 0 -> round(F * 1000);
                _ ->
                    case string:to_integer(V) of
                        {I, ""} when I >= 0 -> I * 1000;
                        _ -> parse_http_date(V, NowSec)
                    end
            end
    end.

parse_http_date(V, NowSec) ->
    try httpd_util:convert_request_date(V) of
        bad_date -> undefined;
        DT ->
            Secs = calendar:datetime_to_gregorian_seconds(DT)
                   - calendar:datetime_to_gregorian_seconds({{1970, 1, 1}, {0, 0, 0}}),
            max(0, Secs - NowSec) * 1000
    catch _:_ -> undefined
    end.

header(Name, Headers) ->
    case [V || {K, V} <- Headers, string:lowercase(to_list(K)) =:= Name] of
        [V | _] -> to_list(V);
        [] -> undefined
    end.

%% errors[] in a 2xx body (bare, or under the {success, data, meta}
%% envelope) names events by their index in the batch.
per_event_errors(Body, Batch) ->
    Errors = case jsone:try_decode(iolist_to_binary(Body)) of
        {ok, #{<<"data">> := #{<<"errors">> := E}}, _} when is_list(E) -> E;
        {ok, #{<<"errors">> := E}, _} when is_list(E) -> E;
        _ -> []
    end,
    Indexed = lists:zip(lists:seq(0, length(Batch) - 1), Batch),
    lists:foldr(fun(#{<<"index">> := I} = Err, {Rej, Ret}) when is_integer(I) ->
                        case lists:keyfind(I, 1, Indexed) of
                            {I, Ev} ->
                                case maps:get(<<"retryable">>, Err, false) of
                                    true -> {Rej, [Ev | Ret]};
                                    _ -> {[Ev | Rej], Ret}
                                end;
                            false -> {Rej, Ret}
                        end;
                   (_, Acc) -> Acc
                end, {[], []}, dedup_errors(Errors)).

%% One verdict per index.
dedup_errors(Errors) ->
    {_, Out} = lists:foldl(fun(#{<<"index">> := I} = E, {Seen, Acc}) ->
                                   case sets:is_element(I, Seen) of
                                       true -> {Seen, Acc};
                                       false -> {sets:add_element(I, Seen), [E | Acc]}
                                   end;
                              (_, SA) -> SA
                           end, {sets:new(), []}, Errors),
    lists:reverse(Out).

%%--------------------------------------------------------------------
%% Batching
%%--------------------------------------------------------------------

-spec chunk(list(), pos_integer()) -> [list()].
chunk([], _N) -> [];
chunk(List, N) when length(List) =< N -> [List];
chunk(List, N) ->
    {Head, Tail} = lists:split(N, List),
    [Head | chunk(Tail, N)].

-spec split_by_size([map()], pos_integer()) -> [[map()]].
split_by_size([], _Max) -> [];
split_by_size([_] = One, _Max) -> [One];
split_by_size(Batch, Max) ->
    case byte_size(jsone:encode(#{<<"events">> => Batch})) =< Max of
        true -> [Batch];
        false ->
            {A, B} = lists:split(length(Batch) div 2, Batch),
            split_by_size(A, Max) ++ split_by_size(B, Max)
    end.

truncate(Bin, Max) when is_binary(Bin), byte_size(Bin) > Max -> binary:part(Bin, 0, Max);
truncate(Bin, _Max) -> Bin.

to_list(B) when is_binary(B) -> binary_to_list(B);
to_list(L) when is_list(L) -> L;
to_list(A) when is_atom(A) -> atom_to_list(A).
