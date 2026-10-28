%%%-------------------------------------------------------------------
%%% 2.0.1: the plugin config is read from EMQX's plugin-config store
%%% (emqx_plugin_helper:get_config/1 -> emqx_plugins:get_config/1), not
%%% from emqx_conf; startup-unsafe values are refused; the shipped
%%% priv/config.hocon, priv/config_schema.avsc and the module's spec/0
%%% agree with each other; every version string matches.
%%%-------------------------------------------------------------------
-module(aforo_metering_config_tests).

-include_lib("eunit/include/eunit.hrl").

-define(C, aforo_metering_config).
-define(VSN, "2.0.2").

%% What EMQX hands over: binary keys, values as HOCON/Avro JSON decoded.
emqx_conf() ->
    #{<<"tenant_id">> => <<"tenant_acme_prod">>,
      <<"product_id">> => <<"prod_mqtt_iot">>,
      <<"api_key">> => <<"sk_live_0123456789">>,
      <<"ingestor_url">> => <<"https://api.aforo.ai/v1/ingest/batch">>,
      <<"aggregation_window_seconds">> => 30,
      <<"aggregate_by_topic">> => true,
      <<"flush_count">> => 200,
      <<"max_buffer_size">> => 1234,
      <<"emit_deliver">> => true,
      <<"exclude_topics">> => [<<"internal/#">>],
      <<"customer_resolver">> => <<"client_attrs">>}.

with_emqx(Reply, Fun) ->
    emqx_plugins:set_reply(Reply),
    try
        ok = ?C:load(),
        Fun()
    after
        emqx_plugins:clear(),
        ?C:clear_overrides()
    end.

%%--------------------------------------------------------------------
%% Reading the config
%%--------------------------------------------------------------------

%% EMQX 5.9+: emqx_plugins:get_config/1 returns the map itself.
load_reads_plugin_config_test() ->
    with_emqx(emqx_conf(), fun() ->
        ?assertEqual([<<"aforo_metering-", ?VSN>>], emqx_plugins:calls()),
        ?assertEqual(<<"tenant_acme_prod">>, ?C:tenant_id()),
        ?assertEqual(<<"prod_mqtt_iot">>, ?C:product_id()),
        ?assertEqual(<<"sk_live_0123456789">>, ?C:api_key()),
        ?assertEqual(30000, ?C:aggregation_window_ms()),
        ?assert(?C:aggregate_by_topic()),
        ?assertEqual(200, ?C:flush_count()),
        ?assertEqual(1234, ?C:max_buffer_size()),
        ?assert(?C:emit_deliver()),
        ?assertEqual([<<"internal/#">>], ?C:exclude_topics()),
        %% keys not in the config keep their defaults
        ?assertEqual(3000, ?C:flush_interval_ms()),
        ?assertEqual(ok, ?C:validate_static())
    end).

%% EMQX 5.7 / 5.8: {ok, Map}.
load_reads_pre_59_shape_test() ->
    with_emqx({ok, emqx_conf()}, fun() ->
        ?assertEqual(<<"tenant_acme_prod">>, ?C:tenant_id()),
        ?assertEqual(200, ?C:flush_count())
    end).

%% If EMQX cannot hand the config over, the plugin must refuse to start
%% -- never run on defaults (the 2.0.0 bug: tenant_default and the
%% default URL were used without a word).
load_failure_refuses_start_test_() ->
    [?_test(with_emqx(R, fun() ->
         ?assertEqual(<<>>, ?C:tenant_id()),
         {error, Errs} = ?C:validate_static(),
         ?assert(has(Errs, <<"tenant_id is not set">>)),
         ?assert(has(Errs, <<"product_id is not set">>)),
         ?assert(has(Errs, <<"api_key is not set">>)),
         ?assert(has(Errs, <<"ingestor_url is not set">>))
     end))
     || R <- [{raise, error, undef}, {error, not_found}, #{}, {ok, #{}}]].

%% Unknown keys are kept out of the snapshot (and never become atoms).
normalize_unknown_keys_test() ->
    N = ?C:normalize(#{<<"tenant_id">> => <<"t">>, <<"tennant_id">> => <<"x">>,
                       <<"aforo_metering_typo_key_xyz">> => 1}),
    ?assertEqual(<<"t">>, maps:get(tenant_id, N)),
    ?assertEqual(lists:sort([<<"tennant_id">>, <<"aforo_metering_typo_key_xyz">>]),
                 lists:sort(maps:get('$unknown', N))),
    ?assertError(badarg, binary_to_existing_atom(<<"aforo_metering_typo_key_xyz">>, utf8)).

%% The 2.0.0 layout nested every key under `aforo_metering { }'.
wrapped_layout_refused_test() ->
    with_emqx(#{<<"aforo_metering">> => emqx_conf()}, fun() ->
        {error, Errs} = ?C:validate_static(),
        ?assert(has(Errs, <<"2.0.0 layout">>))
    end).

%%--------------------------------------------------------------------
%% Startup-unsafe values
%%--------------------------------------------------------------------

valid() ->
    #{tenant_id => <<"tenant_acme_prod">>, product_id => <<"prod_mqtt_iot">>,
      api_key => <<"sk_live_0123456789">>,
      ingestor_url => <<"https://api.aforo.ai/v1/ingest/batch">>}.

errors_for(Overrides) ->
    case ?C:validate(?C:normalize(maps:merge(valid(), Overrides))) of
        ok -> [];
        {error, E} -> E
    end.

valid_config_passes_test() ->
    ?assertEqual([], errors_for(#{})).

refuses_placeholders_test_() ->
    Cases = [
        {#{tenant_id => <<>>}, <<"tenant_id is not set">>},
        {#{tenant_id => <<"   ">>}, <<"tenant_id is not set">>},
        {#{tenant_id => <<"tenant_default">>}, <<"tenant_id is the placeholder">>},
        {#{product_id => <<"prod_mqtt_default">>}, <<"product_id is the placeholder">>},
        {#{product_id => <<>>}, <<"product_id is not set">>},
        {#{api_key => <<>>}, <<"api_key is not set">>},
        {#{api_key => <<"${AFORO_API_KEY}">>}, <<"unresolved placeholder">>},
        {#{api_key => <<"sk_live_...">>}, <<"api_key is a placeholder">>},
        {#{ingestor_url => <<>>}, <<"ingestor_url is not set">>},
        {#{ingestor_url => <<"http://ingest.example.com/v1/ingest/batch">>}, <<"http://">>},
        {#{ingestor_url => <<"ftp://api.aforo.ai/x">>}, <<"unsupported scheme">>},
        {#{ingestor_url => <<"${URL}">>}, <<"unresolved placeholder">>},
        {#{customer_resolver => <<"username">>}, <<"MQTT client chooses">>}
    ],
    [{iolist_to_binary(io_lib:format("~p", [Ov])),
      ?_assert(has(errors_for(Ov), Want))} || {Ov, Want} <- Cases].

accepts_local_http_test_() ->
    [?_assertEqual([], errors_for(#{ingestor_url => U}))
     || U <- [<<"http://localhost:4318/v1/ingest/batch">>,
              <<"http://127.0.0.1:4318/v1/ingest/batch">>,
              <<"http://[::1]:4318/v1/ingest/batch">>]].

insecure_http_needs_opt_in_test() ->
    Url = <<"http://ingest.internal/v1/ingest/batch">>,
    ?assertNotEqual([], errors_for(#{ingestor_url => Url})),
    ?assertEqual([], errors_for(#{ingestor_url => Url, allow_insecure_http => true})).

%% validate/1 looks at the candidate only and leaves the caller's
%% snapshot alone.
validate_candidate_does_not_touch_snapshot_test() ->
    ok = ?C:set_overrides(valid()),
    try
        ?assertMatch({error, _}, ?C:validate(?C:normalize(#{}))),
        ?assertEqual(<<"tenant_acme_prod">>, ?C:tenant_id()),
        ?assertEqual(ok, ?C:validate_static())
    after ?C:clear_overrides()
    end.

redacted_hides_secrets_test() ->
    R = ?C:redacted(maps:merge(valid(), #{customer_resolver_http_authorization => <<>>})),
    ?assertEqual(<<"******">>, maps:get(api_key, R)),
    ?assertEqual(<<"(not set)">>, maps:get(customer_resolver_http_authorization, R)),
    ?assertEqual(<<"tenant_acme_prod">>, maps:get(tenant_id, R)).

%%--------------------------------------------------------------------
%% Shipped files agree with spec/0
%%--------------------------------------------------------------------

priv(F) -> filename:join([code:priv_dir(aforo_metering), F]).

avsc_matches_spec_test() ->
    {ok, Bin} = file:read_file(priv("config_schema.avsc")),
    Schema = jsone:decode(Bin),
    ?assertEqual(<<"record">>, maps:get(<<"type">>, Schema)),
    Fields = maps:get(<<"fields">>, Schema),
    ByName = maps:from_list([{maps:get(<<"name">>, F), F} || F <- Fields]),
    Spec = ?C:spec(),
    ?assertEqual(lists:sort([atom_to_binary(K, utf8) || {K, _, _} <- Spec]),
                 lists:sort(maps:keys(ByName))),
    lists:foreach(fun({K, Type, Default}) ->
        F = maps:get(atom_to_binary(K, utf8), ByName),
        ?assertEqual({K, avro_type(Type)}, {K, maps:get(<<"type">>, F)}),
        case Default of
            required -> ?assertEqual({K, no_default}, {K, maps:get(<<"default">>, F, no_default)});
            _ -> ?assertEqual({K, Default}, {K, maps:get(<<"default">>, F)})
        end
    end, Spec),
    %% secrets are masked in the Dashboard form
    [?assertEqual(<<"input-password">>,
                  maps:get(<<"component">>, maps:get(<<"$ui">>, maps:get(K, ByName))))
     || K <- [<<"api_key">>, <<"customer_resolver_http_authorization">>]].

avro_type(string) -> <<"string">>;
avro_type(int) -> <<"int">>;
avro_type(boolean) -> <<"boolean">>;
avro_type({array, string}) -> #{<<"type">> => <<"array">>, <<"items">> => <<"string">>}.

%% priv/config.hocon is flat `key = value'; every spec key is there with
%% its default (required keys: empty, except the real ingestor URL), and
%% nothing that would leave the plugin running on a placeholder.
hocon_matches_spec_test() ->
    {ok, Bin} = file:read_file(priv("config.hocon")),
    Pairs = [parse_line(L) || L <- binary:split(Bin, <<"\n">>, [global]),
                              is_setting(L)],
    Hocon = maps:from_list(Pairs),
    ?assertEqual(length(Pairs), maps:size(Hocon)),
    Spec = ?C:spec(),
    ?assertEqual(lists:sort([K || {K, _, _} <- Spec]), lists:sort(maps:keys(Hocon))),
    lists:foreach(fun
        ({ingestor_url, _, required}) ->
            ?assertEqual(<<"https://api.aforo.ai/v1/ingest/batch">>, maps:get(ingestor_url, Hocon));
        ({K, _, required}) ->
            ?assertEqual({K, <<>>}, {K, maps:get(K, Hocon)});
        ({K, _, Default}) ->
            ?assertEqual({K, Default}, {K, maps:get(K, Hocon)})
    end, Spec),
    %% the shipped file on its own must not start the plugin
    ok = ?C:set_overrides(Hocon),
    try ?assertMatch({error, _}, ?C:validate_static())
    after ?C:clear_overrides()
    end.

is_setting(L) ->
    T = string:trim(L),
    T =/= <<>> andalso binary:first(T) =/= $#.

parse_line(L) ->
    [K, V] = [string:trim(P) || P <- binary:split(L, <<"=">>)],
    {binary_to_existing_atom(K, utf8), value(V)}.

value(<<"true">>) -> true;
value(<<"false">>) -> false;
value(<<"\"", _/binary>> = S) -> unquote(S);
value(<<"[", _/binary>> = L) ->
    Inner = binary:part(L, 1, byte_size(L) - 2),
    [unquote(string:trim(E)) || E <- binary:split(Inner, <<",">>, [global])];
value(I) -> binary_to_integer(I).

unquote(S) -> binary:part(S, 1, byte_size(S) - 2).

%%--------------------------------------------------------------------
%% Versions
%%--------------------------------------------------------------------

versions_match_test() ->
    _ = application:load(aforo_metering),
    {ok, AppVsn} = application:get_key(aforo_metering, vsn),
    ?assertEqual(?VSN, AppVsn),
    ?assertEqual(<<"aforo_metering-", ?VSN>>, ?C:name_vsn()),
    ?assertEqual(<<?VSN>>, maps:get(version, aforo_metering:health())),
    {ok, Terms} = file:consult(filename:join([app_root(), "rebar.config"])),
    {relx, Relx} = lists:keyfind(relx, 1, Terms),
    {release, {aforo_metering, RelVsn}, Apps} = lists:keyfind(release, 1, Relx),
    ?assertEqual(?VSN, RelVsn),
    %% emqx_plugrel packs exactly these: every runtime dependency outside
    %% OTP and EMQX must be listed.
    ?assertEqual([aforo_metering, emqx_plugin_helper, jsone], Apps).

%% Every version string written into the code or the docs by hand equals
%% the app vsn: the plugin version in health/0, sdkVersion in every usage
%% event, the User-Agent, the fallback name-vsn and the docs' headers.
hard_coded_versions_match_test() ->
    _ = application:load(aforo_metering),
    {ok, AppVsn} = application:get_key(aforo_metering, vsn),
    Root = app_root(),
    Checks = [{"src/aforo_metering.erl", "-define\\(VERSION, <<\"([^\"]+)\">>\\)"},
              {"src/aforo_metering_aggregator.erl", "-define\\(SDK_VERSION, <<\"([^\"]+)\">>\\)"},
              {"src/aforo_metering_transport.erl", "-define\\(USER_AGENT, \"aforo-emqx-plugin/([^\"]+)\"\\)"},
              {"src/aforo_metering_config.erl", "-define\\(FALLBACK_VSN, \"([^\"]+)\"\\)"},
              {"README.md", "\\*\\*Version:\\*\\* ([0-9.]+)"},
              {"USER_GUIDE.md", "\\*\\*Version:\\*\\* ([0-9.]+)"},
              {"priv/config.hocon", "default configuration \\(([0-9.]+)\\)"},
              {"CHANGELOG.md", "## \\[([0-9.]+)\\]"},
              {"../VERSIONING.md", "`aforo-emqx-plugin/` \\| `([0-9.]+)`"}],
    [begin
         {ok, Bin} = file:read_file(filename:join(Root, File)),
         case re:run(Bin, Re, [{capture, all_but_first, list}]) of
             {match, [Found]} -> ?assertEqual({File, AppVsn}, {File, Found});
             nomatch -> ?assertEqual({File, found}, {File, nomatch})
         end
     end || {File, Re} <- Checks],
    %% and the running code agrees with its source
    {ok, Sent} = transport_user_agent(),
    ?assertEqual("aforo-emqx-plugin/" ++ AppVsn, Sent).

transport_user_agent() ->
    Self = self(),
    Http = fun(_Url, Headers, _Body, _T) ->
        Self ! {ua, proplists:get_value("User-Agent", Headers)},
        {ok, {{"HTTP/1.1", 202, "x"}, [], <<"{}">>}}
    end,
    _ = aforo_metering_transport:send([#{<<"idempotencyKey">> => <<"k">>}],
        #{url => <<"http://127.0.0.1:9/x">>, api_key => <<"k">>, tenant => <<"t">>,
          batch_size => 10, timeout_ms => 1000, max_retries => 0, deadline => infinity,
          sleep => fun(_) -> ok end, rand => fun(_) -> 0 end, http => Http}),
    receive {ua, UA} -> {ok, UA} after 1000 -> error end.

%% rebar3 runs eunit from the project root.
app_root() ->
    {ok, Cwd} = file:get_cwd(),
    Cwd.

has(Errs, Sub) ->
    lists:any(fun(E) -> binary:match(E, Sub) =/= nomatch end, Errs).
