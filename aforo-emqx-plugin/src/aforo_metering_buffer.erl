%%%-------------------------------------------------------------------
%%% @doc
%%% Concurrent-safe event buffer for the Aforo MQTT Metering plugin.
%%%
%%% Two ETS tables (`A` and `B`) with an atomic active-table pointer
%%% held in `persistent_term`. Hot-path writers always insert into the
%%% currently active table. Flush atomically swaps the pointer and then
%%% drains the now-inactive table without contending with writers.
%%%
%%% Eliminates the race window in the previous single-table design
%%% where `ets:foldl` + `ets:delete` could miss rows inserted between
%%% the two operations.
%%%
%%% Public API:
%%%   init/0           — create both tables and set initial active pointer
%%%   insert/1         — add an event to the active table (hot path)
%%%   size_active/0    — current depth of the active table
%%%   swap_and_drain/0 — atomic swap, returns all events from the now-inactive table
%%%   delete/0         — delete both tables (called from plugin unload)
%%% @end
%%%-------------------------------------------------------------------
-module(aforo_metering_buffer).

-export([
    init/0,
    insert/1,
    size_active/0,
    swap_and_drain/0,
    delete/0
]).

-define(TAB_A, aforo_metering_buffer_a).
-define(TAB_B, aforo_metering_buffer_b).
-define(ACTIVE_KEY, {?MODULE, active}).

-spec init() -> ok.
init() ->
    ensure_table(?TAB_A),
    ensure_table(?TAB_B),
    persistent_term:put(?ACTIVE_KEY, ?TAB_A),
    ok.

ensure_table(Name) ->
    case ets:info(Name) of
        undefined ->
            _ = ets:new(Name, [
                named_table, public, ordered_set,
                {write_concurrency, true},
                {read_concurrency, true}
            ]),
            ok;
        _ -> ok
    end.

%% Insert an event into the currently active table.
%% Key includes a monotonic suffix to preserve insertion order even when
%% two writers hit the same millisecond.
-spec insert(map()) -> ok.
insert(Event) ->
    Now = erlang:system_time(millisecond),
    Key = {Now, erlang:unique_integer([monotonic, positive])},
    Active = active_table(),
    true = ets:insert(Active, {Key, Event}),
    ok.

-spec size_active() -> non_neg_integer().
size_active() ->
    case ets:info(active_table(), size) of
        undefined -> 0;
        N when is_integer(N) -> N
    end.

%% Atomically swap which table is active, then drain the now-inactive table.
%% Concurrent writers are unaffected — they continue inserting into the
%% newly-active table while we drain the old one.
-spec swap_and_drain() -> [map()].
swap_and_drain() ->
    Old = active_table(),
    New = case Old of ?TAB_A -> ?TAB_B; _ -> ?TAB_A end,
    persistent_term:put(?ACTIVE_KEY, New),
    %% Atomic per-row drain via ets:take — race-free against any in-flight
    %% writer that read Old as the active table BEFORE the swap and is now
    %% completing its insert. Such writes either land before our take (we
    %% see them) or after (next swap-cycle picks them up — at most one
    %% flush of latency, never lost).
    %%
    %% NOTE: replaces the earlier tab2list + delete_all_objects pair. The
    %% old version had a small window between tab2list and delete_all_objects
    %% where late writes were silently truncated.
    drain_loop(Old, []).

%% Pop one row at a time using ets:take/2, which is atomic per-row.
%% On ordered_set tables ets:first/1 + ets:take/2 is the standard
%% race-free pop pattern.
drain_loop(Tab, Acc) ->
    case ets:first(Tab) of
        '$end_of_table' -> lists:reverse(Acc);
        Key ->
            case ets:take(Tab, Key) of
                [{_K, Event}] -> drain_loop(Tab, [Event | Acc]);
                %% If take returns [], another caller raced us. We never
                %% expect that here (single flusher), but handle it
                %% defensively so the loop terminates.
                [] -> drain_loop(Tab, Acc)
            end
    end.

-spec delete() -> ok.
delete() ->
    catch ets:delete(?TAB_A),
    catch ets:delete(?TAB_B),
    catch persistent_term:erase(?ACTIVE_KEY),
    ok.

%% ── Internals ──────────────────────────────────────────────────────

active_table() ->
    persistent_term:get(?ACTIVE_KEY, ?TAB_A).
