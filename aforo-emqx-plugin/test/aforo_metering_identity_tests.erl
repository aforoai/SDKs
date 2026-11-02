%%%-------------------------------------------------------------------
%%% G363: the customer is taken from what EMQX authentication verified,
%%% never from a value the MQTT client chooses unless the operator opts
%%% in by name.
%%%-------------------------------------------------------------------
-module(aforo_metering_identity_tests).

-include_lib("eunit/include/eunit.hrl").

-define(R, aforo_metering_customer_resolver).

setup(Cfg) ->
    aforo_test_util:with_config(Cfg),
    ok = aforo_metering_cache:init().

cleanup() ->
    aforo_metering_cache:delete(),
    aforo_test_util:reset_config().

with(Cfg, Fun) ->
    setup(Cfg),
    try Fun() after cleanup() end.

errors_mention(Sub, {error, Errs}) ->
    lists:any(fun(E) -> binary:match(E, Sub) =/= nomatch end, Errs);
errors_mention(_, ok) -> false.

%% The default config validates and resolves from client_attrs.
default_is_client_attrs_test() ->
    with(#{}, fun() ->
        ?assertEqual(<<"client_attrs">>, aforo_metering_config:customer_resolver()),
        ?assertEqual(ok, aforo_metering_config:validate())
    end).

client_attrs_reads_the_authenticated_attribute_test() ->
    with(#{}, fun() ->
        CI = #{clientid => <<"dev-1">>, username => <<"victim_customer">>,
               client_attrs => #{<<"aforo_customer_id">> => <<"cust_real">>}},
        ?assertEqual(<<"cust_real">>, ?R:resolve_connect(CI, #{}))
    end).

%% A client that sets its username to someone else's customer id must
%% not be billed to that customer when authn set no attribute.
username_is_ignored_by_default_test() ->
    with(#{}, fun() ->
        CI = #{clientid => <<"dev-2">>, username => <<"cust_victim">>},
        ?assertEqual(undefined, ?R:resolve_connect(CI, #{})),
        ?assertEqual(undefined, ?R:lookup(<<"dev-2">>))
    end).

attribute_name_is_configurable_test() ->
    with(#{customer_resolver_client_attr => <<"tenant_customer">>}, fun() ->
        CI = #{clientid => <<"c">>, client_attrs => #{<<"tenant_customer">> => <<"cust_9">>,
                                                    <<"aforo_customer_id">> => <<"other">>}},
        ?assertEqual(<<"cust_9">>, ?R:resolve_connect(CI, #{}))
    end).

blank_attribute_is_no_customer_test() ->
    with(#{}, fun() ->
        CI = #{clientid => <<"c">>, client_attrs => #{<<"aforo_customer_id">> => <<"  ">>}},
        ?assertEqual(undefined, ?R:resolve_connect(CI, #{}))
    end).

unsafe_backends_refuse_to_load_without_opt_in_test_() ->
    [?_test(with(#{customer_resolver => B}, fun() ->
         R = aforo_metering_config:validate(),
         ?assertMatch({error, _}, R),
         ?assert(errors_mention(<<"unsafe_trust_client_identity">>, R))
     end)) || B <- [<<"username">>, <<"clientid_prefix">>, <<"jwt_unverified">>]].

unsafe_backends_load_with_opt_in_test_() ->
    [?_test(with(#{customer_resolver => B, unsafe_trust_client_identity => true}, fun() ->
         ?assertEqual(ok, aforo_metering_config:validate())
     end)) || B <- [<<"username">>, <<"clientid_prefix">>, <<"jwt_unverified">>]].

username_with_opt_in_still_works_test() ->
    with(#{customer_resolver => <<"username">>, unsafe_trust_client_identity => true}, fun() ->
        ?assertEqual(<<"alice">>, ?R:resolve_connect(#{clientid => <<"c">>, username => <<"alice">>}, #{}))
    end).

%% The old "jwt" backend decoded tokens without checking the signature.
jwt_backend_is_refused_test() ->
    with(#{customer_resolver => <<"jwt">>, unsafe_trust_client_identity => true}, fun() ->
        R = aforo_metering_config:validate(),
        ?assertMatch({error, _}, R),
        ?assert(errors_mention(<<"client_attrs">>, R))
    end).

%% Before 2.0.0 an unknown backend fell back to the username.
unknown_backend_is_refused_and_never_falls_back_test() ->
    with(#{customer_resolver => <<"usernmae">>}, fun() ->
        ?assertMatch({error, _}, aforo_metering_config:validate()),
        ?assertEqual(undefined, ?R:resolve_sync(<<"usernmae">>,
                                                #{clientid => <<"c">>, username => <<"u">>}, #{}))
    end).

jwt_unverified_reads_claim_test() ->
    with(#{customer_resolver => <<"jwt_unverified">>, unsafe_trust_client_identity => true}, fun() ->
        Payload = base64:encode(jsone:encode(#{<<"sub">> => <<"cust_jwt">>}), #{mode => urlsafe, padding => false}),
        Token = <<"eyJhbGciOiJub25lIn0.", Payload/binary, ".sig">>,
        ConnInfo = #{conn_props => #{'Authentication-Data' => Token}},
        ?assertEqual(<<"cust_jwt">>, ?R:resolve_connect(#{clientid => <<"c">>}, ConnInfo))
    end).

http_backend_needs_url_test() ->
    with(#{customer_resolver => <<"http">>}, fun() ->
        ?assertMatch({error, _}, aforo_metering_config:validate())
    end).

http_response_parsing_test_() ->
    R = fun(Code, Body) -> {ok, {{"HTTP/1.1", Code, "x"}, [], Body}} end,
    [?_assertEqual(<<"c1">>, ?R:parse_http_response(R(200, <<"{\"customerId\":\"c1\"}">>))),
     ?_assertEqual(<<"c2">>, ?R:parse_http_response(R(200, <<"{\"data\":{\"customerId\":\"c2\"}}">>))),
     ?_assertEqual(undefined, ?R:parse_http_response(R(200, <<"{\"customerId\":\"\"}">>))),
     ?_assertEqual(undefined, ?R:parse_http_response(R(404, <<>>))),
     ?_assertEqual(undefined, ?R:parse_http_response({error, timeout}))].
