%%%-------------------------------------------------------------------
%%% @doc
%%% Customer-ID lookup cache for the Aforo MQTT Metering plugin.
%%%
%%% A simple ETS table keyed by {tenant, clientid} → customer_id.
%%% Populated by aforo_metering_customer_resolver:resolve/2 on the first
%%% lookup for a connection, invalidated on client.disconnected. Avoids
%%% repeating expensive resolver lookups (HTTP / JWT decode) per message.
%%%
%%% Counters incremented:
%%%   aforo.metering.customer_lookup.hit
%%%   aforo.metering.customer_lookup.miss
%%% @end
%%%-------------------------------------------------------------------
-module(aforo_metering_cache).

-export([
    init/0,
    get/2,
    put/3,
    invalidate/2,
    size/0
]).

-define(TAB, aforo_metering_customer_cache).

-spec init() -> ok.
init() ->
    case ets:info(?TAB) of
        undefined ->
            _ = ets:new(?TAB, [
                named_table, public, set,
                {read_concurrency, true},
                {write_concurrency, true}
            ]),
            ok;
        _ -> ok
    end.

%% Returns {ok, CustomerId} | not_found
-spec get(binary(), binary()) -> {ok, binary()} | not_found.
get(TenantId, ClientId) ->
    case ets:lookup(?TAB, {TenantId, ClientId}) of
        [{_, CustomerId}] ->
            aforo_metering_metrics:inc('aforo.metering.customer_lookup.hit', 1),
            {ok, CustomerId};
        [] ->
            aforo_metering_metrics:inc('aforo.metering.customer_lookup.miss', 1),
            not_found
    end.

-spec put(binary(), binary(), binary()) -> ok.
put(_TenantId, _ClientId, undefined) -> ok;  % don't cache nulls
put(TenantId, ClientId, CustomerId) ->
    true = ets:insert(?TAB, {{TenantId, ClientId}, CustomerId}),
    ok.

-spec invalidate(binary(), binary()) -> ok.
invalidate(TenantId, ClientId) ->
    true = ets:delete(?TAB, {TenantId, ClientId}),
    ok.

-spec size() -> non_neg_integer().
size() ->
    case ets:info(?TAB, size) of
        undefined -> 0;
        N when is_integer(N) -> N
    end.
