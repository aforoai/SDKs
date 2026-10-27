%%%-------------------------------------------------------------------
%%% @doc
%%% Customer-ID cache for the Aforo MQTT Metering plugin.
%%%
%%% ETS table keyed by {tenant, clientid}. Each row is
%%%   {Key, Status, Value, ExpiresAt, Conn, Username}
%%% where Status / Value is
%%%   ok      / CustomerId          -- resolved
%%%   none    / undefined           -- "no customer" or a failed lookup,
%%%                                    retried after the negative TTL
%%%   pending / {Ref, Previous}     -- an async lookup is running;
%%%                                    Previous (the last good customer,
%%%                                    or undefined) is used meanwhile
%%% ExpiresAt is a monotonic millisecond time or `infinity'. Conn is the
%%% connection the row belongs to (EMQX `connected_at'), or `gone' once
%%% that connection disconnected. Username is kept so an http lookup can
%%% be retried from message.publish, which carries only the clientid.
%%%
%%% The table is owned by aforo_metering_sup, so it survives a crash of
%%% any worker. `sweep/0' removes rows of gone connections and expired
%%% positive rows; the resolver pool calls it periodically.
%%%
%%% Counters: aforo.metering.customer_lookup.hit / .miss / .negative
%%% @end
%%%-------------------------------------------------------------------
-module(aforo_metering_cache).

-export([
    init/0,
    delete/0,
    get/2,
    put/3,
    put/5,
    put_negative/3,
    put_pending/5,
    complete_pending/4,
    refuse_pending/3,
    retry_inputs/2,
    conn_of/2,
    expire_after/4,
    invalidate/2,
    sweep/0,
    size/0,
    now_ms/0
]).

-define(TAB, aforo_metering_customer_cache).

-spec init() -> ok.
init() ->
    case ets:info(?TAB) of
        undefined ->
            _ = ets:new(?TAB, [named_table, public, set,
                               {read_concurrency, true}, {write_concurrency, true}]),
            ok;
        _ -> ok
    end.

-spec delete() -> ok.
delete() ->
    try ets:delete(?TAB) catch _:_ -> ok end,
    ok.

now_ms() -> erlang:monotonic_time(millisecond).

live(infinity, _Now) -> true;
live(Exp, Now) -> Exp > Now.

-spec get(binary(), binary()) -> {ok, binary()} | negative | pending | not_found.
get(TenantId, ClientId) ->
    Now = now_ms(),
    case lookup({TenantId, ClientId}) of
        [{_, ok, C, Exp, _, _}] ->
            case live(Exp, Now) of
                true -> hit(C);
                false -> miss()
            end;
        [{_, pending, {_Ref, Prev}, Exp, _, _}] ->
            case {live(Exp, Now), Prev} of
                {true, undefined} -> pending;
                {true, P} -> hit(P);
                {false, _} -> miss()
            end;
        [{_, none, _, Exp, _, _}] ->
            case live(Exp, Now) of
                true ->
                    aforo_metering_metrics:inc('aforo.metering.customer_lookup.negative', 1),
                    negative;
                false -> miss()
            end;
        _ -> miss()
    end.

hit(C) ->
    aforo_metering_metrics:inc('aforo.metering.customer_lookup.hit', 1),
    {ok, C}.

miss() ->
    aforo_metering_metrics:inc('aforo.metering.customer_lookup.miss', 1),
    not_found.

lookup(Key) ->
    try ets:lookup(?TAB, Key) catch error:badarg -> [] end.

%% Positive or negative result for the current connection.
-spec put(binary(), binary(), binary() | undefined) -> ok.
put(TenantId, ClientId, CustomerId) ->
    put(TenantId, ClientId, CustomerId, undefined, <<>>).

-spec put(binary(), binary(), binary() | undefined, term(), binary()) -> ok.
put(TenantId, ClientId, undefined, Conn, Username) ->
    insert({{TenantId, ClientId}, none, undefined,
            now_ms() + aforo_metering_config:negative_ttl_ms(), Conn, Username});
put(TenantId, ClientId, CustomerId, Conn, Username) ->
    insert({{TenantId, ClientId}, ok, CustomerId, infinity, Conn, Username}).

-spec put_negative(binary(), binary(), pos_integer()) -> ok.
put_negative(TenantId, ClientId, TtlMs) ->
    Key = {TenantId, ClientId},
    {Conn, User} = case lookup(Key) of
        [{_, _, _, _, C, U}] -> {C, U};
        [] -> {undefined, <<>>}
    end,
    insert({Key, none, undefined, now_ms() + TtlMs, Conn, User}).

%% Start (or restart) an async lookup. Within one connection the last
%% good customer is kept and used until the answer arrives; a new
%% connection (possibly a different identity) starts without one.
-spec put_pending(binary(), binary(), reference(), pos_integer(), {term(), binary()}) -> ok.
put_pending(TenantId, ClientId, Ref, TtlMs, {Conn, Username}) ->
    Key = {TenantId, ClientId},
    Now = now_ms(),
    Prev = case lookup(Key) of
        [{_, ok, C, Exp, Conn, _}] when Conn =/= undefined, Conn =/= gone ->
            case live(Exp, Now) of true -> C; false -> undefined end;
        [{_, pending, {_, P}, _, Conn, _}] when Conn =/= undefined, Conn =/= gone -> P;
        _ -> undefined
    end,
    insert({Key, pending, {Ref, Prev}, now_ms() + TtlMs, Conn, Username}).

%% Store an async result only if the row is still the lookup Ref
%% started; an older, slower answer never overwrites a newer lookup.
-spec complete_pending(binary(), binary(), reference(), binary() | undefined) -> ok | stale.
complete_pending(TenantId, ClientId, Ref, Result) ->
    Key = {TenantId, ClientId},
    case lookup(Key) of
        [{_, pending, {Ref, _}, Exp, Conn, User}] ->
            Exp1 = case Conn of
                gone -> Exp;  %% disconnected meanwhile: keep the short expiry
                _ -> infinity
            end,
            case Result of
                undefined ->
                    insert({Key, none, undefined,
                            now_ms() + aforo_metering_config:negative_ttl_ms(), Conn, User});
                C ->
                    insert({Key, ok, C, Exp1, Conn, User})
            end;
        _ -> stale
    end.

%% The lookup could not be queued: fall back to the previous customer if
%% there was one, otherwise cache a miss.
-spec refuse_pending(binary(), binary(), reference()) -> ok.
refuse_pending(TenantId, ClientId, Ref) ->
    Key = {TenantId, ClientId},
    case lookup(Key) of
        [{_, pending, {Ref, Prev}, _, Conn, User}] when is_binary(Prev) ->
            insert({Key, ok, Prev, infinity, Conn, User});
        [{_, pending, {Ref, _}, _, _, _}] ->
            put_negative(TenantId, ClientId, aforo_metering_config:negative_ttl_ms());
        _ -> ok
    end.

%% For a live connection whose negative or pending row has expired:
%% the username to retry the http lookup with.
-spec retry_inputs(binary(), binary()) -> {ok, term(), binary()} | none.
retry_inputs(TenantId, ClientId) ->
    case lookup({TenantId, ClientId}) of
        [{_, S, _, Exp, Conn, User}] when (S =:= none orelse S =:= pending), Conn =/= gone ->
            case live(Exp, now_ms()) of
                false -> {ok, Conn, User};
                true -> none
            end;
        _ -> none
    end.

%% client.disconnected: keep the row readable for Ms (so windows this
%% client contributed to can still be attributed), then let it go. Only
%% the connection that owns the row may do this: after a session
%% takeover the old channel's disconnect must not expire the new one's.
-spec expire_after(binary(), binary(), term(), non_neg_integer()) -> ok.
expire_after(TenantId, ClientId, Conn, Ms) ->
    Key = {TenantId, ClientId},
    case lookup(Key) of
        [{_, S, V, _, RowConn, User}]
          when Conn =:= undefined; RowConn =:= undefined; RowConn =:= Conn ->
            insert({Key, S, V, now_ms() + Ms, gone, User});
        _ -> ok
    end.

%% The connection marker of an existing row, or undefined.
-spec conn_of(binary(), binary()) -> term().
conn_of(TenantId, ClientId) ->
    case lookup({TenantId, ClientId}) of
        [{_, _, _, _, Conn, _}] when Conn =/= gone -> Conn;
        _ -> undefined
    end.

-spec invalidate(binary(), binary()) -> ok.
invalidate(TenantId, ClientId) ->
    try ets:delete(?TAB, {TenantId, ClientId}) catch _:_ -> ok end,
    ok.

%% Delete expired rows of gone connections, and expired positive rows.
%% Rows of live connections in `none' / `pending' stay (bounded by the
%% number of connected clients) so a lookup can be retried.
-spec sweep() -> non_neg_integer().
sweep() ->
    Now = now_ms(),
    try ets:select_delete(?TAB, [
            {{'_', '_', '_', '$1', gone, '_'},
             [{'andalso', {is_integer, '$1'}, {'=<', '$1', Now}}], [true]},
            {{'_', ok, '_', '$1', '_', '_'},
             [{'andalso', {is_integer, '$1'}, {'=<', '$1', Now}}], [true]}])
    catch error:badarg -> 0
    end.

-spec size() -> non_neg_integer().
size() ->
    case ets:info(?TAB, size) of
        N when is_integer(N) -> N;
        _ -> 0
    end.

insert(Row) ->
    try ets:insert(?TAB, Row) catch _:_ -> ok end,
    ok.
