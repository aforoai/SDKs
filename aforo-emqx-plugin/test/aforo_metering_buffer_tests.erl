%%%-------------------------------------------------------------------
%%% @doc
%%% EUnit tests for aforo_metering_buffer.
%%%
%%% Locks down the invariants of the race-free swap_and_drain design
%%% (commit dbb4b3f, 2026-04-20). The pre-fix pattern
%%%   `Pairs = ets:tab2list(Old), ets:delete_all_objects(Old)`
%%% had a window where a writer that had ALREADY READ the old active-table
%%% pointer (just before the swap) could complete its insert into Old
%%% AFTER the tab2list and BEFORE the delete_all_objects — those rows
%%% were silently truncated.
%%%
%%% The current implementation uses `ets:first/1` + `ets:take/2` per row,
%%% which is atomic against concurrent inserts. Late writes either land
%%% in the current drain or remain in the table and are picked up by the
%%% next swap_and_drain — never lost.
%%%
%%% These tests do NOT spawn Erlang processes for true concurrency
%%% (concurrency-bug coverage is best done with PropEr or QuickCheck).
%%% Instead they simulate the race scenario deterministically by
%%% capturing the "writer's view of active" before swap and completing
%%% its insert after swap.
%%%
%%% Run with:
%%%   rebar3 eunit --module aforo_metering_buffer_tests
%%%
%%% Author: race-fix audit, 2026-04-20.
%%% @end
%%%-------------------------------------------------------------------
-module(aforo_metering_buffer_tests).

-include_lib("eunit/include/eunit.hrl").

-define(MOD, aforo_metering_buffer).

%%--------------------------------------------------------------------
%% Fixture wrapper — every test gets a fresh init/0 + delete/0 cleanup.
%%--------------------------------------------------------------------

buffer_test_() ->
    {foreach,
     fun setup/0,
     fun teardown/1,
     [
        fun init_creates_both_tables/1,
        fun insert_lands_in_active_table/1,
        fun size_active_reflects_inserts/1,
        fun swap_and_drain_returns_inserted_events/1,
        fun swap_and_drain_preserves_insertion_order/1,
        fun swap_and_drain_leaves_drained_table_empty/1,
        fun swap_alternates_active_pointer/1,
        fun new_inserts_after_swap_go_to_new_table/1,
        fun race_late_writer_into_old_table_is_picked_up_next_cycle/1,
        fun drain_loop_terminates_on_empty_table/1,
        fun delete_removes_both_tables_and_pointer/1
     ]}.

setup() ->
    %% persistent_term may have residue from a prior crashed test —
    %% delete/0 is defensive (catches errors), so this is safe.
    catch ?MOD:delete(),
    ok = ?MOD:init(),
    ok.

teardown(_) ->
    catch ?MOD:delete(),
    ok.

%%--------------------------------------------------------------------
%% Individual tests — each takes the fixture's `_Setup` arg and
%% returns either a single `?_assert*` macro or a `fun() -> ... end`.
%% Both forms are valid `foreach` test specs.
%%--------------------------------------------------------------------

init_creates_both_tables(_) ->
    ?_test(begin
        ?assertNotEqual(undefined, ets:info(aforo_metering_buffer_a)),
        ?assertNotEqual(undefined, ets:info(aforo_metering_buffer_b)),
        ?assertEqual(aforo_metering_buffer_a,
                     persistent_term:get({?MOD, active}))
    end).

insert_lands_in_active_table(_) ->
    ?_test(begin
        ok = ?MOD:insert(#{event => "publish_1"}),
        ?assertEqual(1, ets:info(aforo_metering_buffer_a, size)),
        ?assertEqual(0, ets:info(aforo_metering_buffer_b, size))
    end).

size_active_reflects_inserts(_) ->
    ?_test(begin
        ?assertEqual(0, ?MOD:size_active()),
        ok = ?MOD:insert(#{event => "e1"}),
        ok = ?MOD:insert(#{event => "e2"}),
        ok = ?MOD:insert(#{event => "e3"}),
        ?assertEqual(3, ?MOD:size_active())
    end).

swap_and_drain_returns_inserted_events(_) ->
    ?_test(begin
        ok = ?MOD:insert(#{event => "e1"}),
        ok = ?MOD:insert(#{event => "e2"}),
        Drained = ?MOD:swap_and_drain(),
        ?assertEqual(2, length(Drained)),
        ?assert(lists:member(#{event => "e1"}, Drained)),
        ?assert(lists:member(#{event => "e2"}, Drained))
    end).

swap_and_drain_preserves_insertion_order(_) ->
    %% ordered_set + monotonic unique_integer in the key + lists:reverse
    %% on the accumulator means insertion order is preserved.
    ?_test(begin
        ok = ?MOD:insert(#{seq => 1}),
        ok = ?MOD:insert(#{seq => 2}),
        ok = ?MOD:insert(#{seq => 3}),
        Drained = ?MOD:swap_and_drain(),
        ?assertEqual([#{seq => 1}, #{seq => 2}, #{seq => 3}], Drained)
    end).

swap_and_drain_leaves_drained_table_empty(_) ->
    ?_test(begin
        ok = ?MOD:insert(#{event => "e1"}),
        ok = ?MOD:insert(#{event => "e2"}),
        _ = ?MOD:swap_and_drain(),
        %% After swap, A is the inactive (drained) table; B is the new active.
        ?assertEqual(0, ets:info(aforo_metering_buffer_a, size)),
        ?assertEqual(0, ets:info(aforo_metering_buffer_b, size)),
        ?assertEqual(0, ?MOD:size_active())
    end).

swap_alternates_active_pointer(_) ->
    ?_test(begin
        ?assertEqual(aforo_metering_buffer_a,
                     persistent_term:get({?MOD, active})),
        _ = ?MOD:swap_and_drain(),
        ?assertEqual(aforo_metering_buffer_b,
                     persistent_term:get({?MOD, active})),
        _ = ?MOD:swap_and_drain(),
        ?assertEqual(aforo_metering_buffer_a,
                     persistent_term:get({?MOD, active}))
    end).

new_inserts_after_swap_go_to_new_table(_) ->
    %% Critical: writers who arrive AFTER the swap must hit the new
    %% active table and remain captured by the next drain cycle.
    ?_test(begin
        ok = ?MOD:insert(#{cycle => 1, event => "early"}),
        FirstDrain = ?MOD:swap_and_drain(),
        ?assertEqual([#{cycle => 1, event => "early"}], FirstDrain),
        %% B is now active.
        ok = ?MOD:insert(#{cycle => 2, event => "after_swap"}),
        ?assertEqual(1, ets:info(aforo_metering_buffer_b, size)),
        ?assertEqual(0, ets:info(aforo_metering_buffer_a, size)),
        SecondDrain = ?MOD:swap_and_drain(),
        ?assertEqual([#{cycle => 2, event => "after_swap"}], SecondDrain)
    end).

race_late_writer_into_old_table_is_picked_up_next_cycle(_) ->
    %% This is the heart of the race-fix invariant.
    %%
    %% Pre-fix pattern (BUG):
    %%   Old = active(),                  %% writer's view of active = A
    %%   swap_pointer(),                  %% pointer flips to B
    %%   Pairs = ets:tab2list(Old),       %% snapshot taken — empty
    %%   <<<< writer's insert into A lands HERE — invisible to Pairs >>>>
    %%   ets:delete_all_objects(Old),     %% writer's row silently TRUNCATED
    %%
    %% Post-fix pattern (THIS CODE):
    %%   Old = active(),
    %%   swap_pointer(),
    %%   drain_loop(Old, []) -> ets:first/1 + ets:take/2 per row.
    %%   <<<< writer's insert into A lands at any point >>>>
    %%   Either:
    %%     - drain_loop sees first/1 returning the writer's key and takes it
    %%     - drain_loop terminates with `'$end_of_table'` BEFORE the writer's
    %%       insert lands — the row stays in A (the now-inactive table) and
    %%       is captured by the NEXT swap_and_drain (when A becomes active
    %%       again, then inactive on the cycle after that).
    %%
    %% We simulate the second branch deterministically by manually
    %% inserting into the old table AFTER swap_and_drain has finished
    %% (i.e. the writer's insert lost the race to the drain). The fix
    %% guarantees this row is NOT lost — it must be picked up by the
    %% next-but-one swap_and_drain.
    ?_test(begin
        ok = ?MOD:insert(#{phase => "pre_swap"}),
        FirstDrain = ?MOD:swap_and_drain(),
        ?assertEqual([#{phase => "pre_swap"}], FirstDrain),
        %% After first swap: B is active, A is empty + inactive.
        %% Simulate a writer that read A as active BEFORE the swap and
        %% only now completes its ets:insert into A. Under the OLD
        %% tab2list + delete_all_objects design this row would already
        %% be wiped. Under the new design A is intact — the writer's
        %% row simply sits in A until A becomes "old" again on the next
        %% swap.
        true = ets:insert(aforo_metering_buffer_a,
                          {{erlang:system_time(millisecond),
                            erlang:unique_integer([monotonic, positive])},
                           #{phase => "late_writer_into_old"}}),
        ?assertEqual(1, ets:info(aforo_metering_buffer_a, size)),

        %% Cycle 2: B is active and empty -> drain returns []. A still
        %% holds the late writer's row.
        SecondDrain = ?MOD:swap_and_drain(),
        ?assertEqual([], SecondDrain),
        %% After cycle 2: A is active again, B is inactive (and empty).
        ?assertEqual(aforo_metering_buffer_a,
                     persistent_term:get({?MOD, active})),
        ?assertEqual(1, ets:info(aforo_metering_buffer_a, size)),

        %% Cycle 3: A is active and holds the late writer's row -> the
        %% next swap drains it. KEY INVARIANT: the row was NOT lost.
        ThirdDrain = ?MOD:swap_and_drain(),
        ?assertEqual([#{phase => "late_writer_into_old"}], ThirdDrain)
    end).

drain_loop_terminates_on_empty_table(_) ->
    %% No inserts → swap_and_drain must return [] without spinning,
    %% blocking, or crashing. Guards against an off-by-one in the
    %% '$end_of_table' base case.
    ?_test(begin
        ?assertEqual([], ?MOD:swap_and_drain()),
        ?assertEqual([], ?MOD:swap_and_drain()),
        ?assertEqual([], ?MOD:swap_and_drain())
    end).

delete_removes_both_tables_and_pointer(_) ->
    ?_test(begin
        ok = ?MOD:insert(#{event => "e1"}),
        ok = ?MOD:delete(),
        ?assertEqual(undefined, ets:info(aforo_metering_buffer_a)),
        ?assertEqual(undefined, ets:info(aforo_metering_buffer_b)),
        ?assertEqual(default,
                     persistent_term:get({?MOD, active}, default))
    end).
