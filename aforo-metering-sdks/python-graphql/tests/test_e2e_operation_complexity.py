"""End-to-end review finding (2026-11-09): the default complexity scorer walked
the whole document, so a request carrying several operations (or unused
fragments) billed ``gqlComplexity`` / ``gqlFieldCount`` for all of them. Only
the operation that runs counts: ``operationName``'s, else the only/first one.
Same rules as the Node SDK's ``defaultComplexityScorer``."""

from __future__ import annotations

import pytest

from fakes import ScriptedServer
from aforo_graphql_metering import AforoGraphQlBilling
from aforo_graphql_metering.client import default_complexity_scorer

graphql = pytest.importorskip("graphql")
parse = graphql.parse

TWO_OPS = """
query Small { a }
query Big { user { profile { name email avatar } posts { title body } } }
"""


def test_only_the_named_operation_is_scored():
    doc = parse(TWO_OPS)
    assert default_complexity_scorer(doc, "Small") == (1 + 5 * 1, 1)
    assert default_complexity_scorer(doc, "Big") == (8 + 5 * 3, 8)


def test_without_a_name_the_first_operation_is_scored():
    assert default_complexity_scorer(parse(TWO_OPS)) == (1 + 5, 1)
    assert default_complexity_scorer(parse("{ a b c }")) == (3 + 5, 3)


def test_unused_fragments_do_not_count_and_used_ones_count_where_spread():
    doc = parse("""
    query Q { me { ...Who } friend { ...Who } }
    fragment Who on User { id name }
    fragment Unused on User { a b c d e f g h }
    """)
    # me, friend + 2 x (id, name) = 6 fields; depth 2 (me -> id)
    assert default_complexity_scorer(doc, "Q") == (6 + 5 * 2, 6)


def test_inline_fragments_add_no_depth_and_bad_spreads_count_nothing():
    doc = parse("""
    query Q { node { ... on User { id ...Loop ...Missing } } }
    fragment Loop on User { name ...Loop }
    """)
    # node, id, name (Loop once; its self-spread and the unknown spread add nothing)
    assert default_complexity_scorer(doc, "Q") == (3 + 5 * 2, 3)


def test_fan_out_is_linear_and_capped_at_java_int():
    defs = ["fragment F0 on T { a b }"]
    for i in range(1, 60):  # each fragment spreads the previous twice: 2**60 fields when expanded
        defs.append(f"fragment F{i} on T {{ x: a ...F{i - 1} ...F{i - 1} }}")
    doc = parse("query Q { root { ...F59 } }\n" + "\n".join(defs))
    complexity, fields = default_complexity_scorer(doc, "Q")
    assert fields == 2**31 - 1 and complexity == 2**31 - 1


@pytest.mark.real_transport
def test_record_bills_only_the_operation_that_runs():
    server = ScriptedServer()
    b = AforoGraphQlBilling(tenant_id="t", product_id="p", api_key="k", ingestor_url="https://ingest.example.test",
                            flush_interval_sec=3600, http_transport=server.transport())
    b.record("cust_1", TWO_OPS, "Small", 3, False)
    b.record("cust_1", TWO_OPS, "Big", 3, False)
    b.shutdown()
    events = [e for r in server.requests for e in r["body"]["events"]]
    assert [(e["gqlOperationName"], e["gqlFieldCount"], e["gqlComplexity"]) for e in events] == [
        ("Small", 1, 6), ("Big", 8, 23)]
