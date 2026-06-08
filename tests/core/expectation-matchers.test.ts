import assert from "node:assert/strict";
import { test } from "node:test";
import {
  durationsEquivalent,
  exprShape,
  exprToShapeNode,
  lenientNameMatches,
  parseShape,
  partyMatches,
  proseOverlapMatches,
  shapesMatch,
} from "../../src/core/expectation-matchers.js";
import type { Expr, Party } from "../../src/types/ir.js";

test("shapesMatch treats mul as commutative", () => {
  const expected = parseShape("max(mul(var(new_balance), const(0.03)), const(15))");
  assert.ok(expected);
  const actual: Expr = {
    op: "max",
    args: [
      { op: "mul", args: [{ op: "const", value: 0.03 }, { op: "var", name: "new_balance" }] },
      { op: "const", value: 15 },
    ],
  };
  assert.ok(shapesMatch(expected!, exprToShapeNode(actual)));
});

test("var(*) in expected shape matches any variable name", () => {
  const expected = parseShape("mul(const(0.01), var(*))");
  assert.ok(expected);
  const actual: Expr = {
    op: "mul",
    args: [
      { op: "const", value: 0.01 },
      { op: "var", name: "international_transaction_amount_usd" },
    ],
  };
  assert.ok(shapesMatch(expected!, exprToShapeNode(actual)));
});

test("shapesMatch rejects wrong constants even under commutativity", () => {
  const expected = parseShape("mul(var(x), const(0.03))");
  assert.ok(expected);
  const actual: Expr = {
    op: "mul",
    args: [{ op: "const", value: 0.05 }, { op: "var", name: "x" }],
  };
  assert.ok(!shapesMatch(expected!, exprToShapeNode(actual)));
});

test("exprShape renders commutative args in sorted order", () => {
  const commuted: Expr = {
    op: "mul",
    args: [{ op: "const", value: 0.03 }, { op: "var", name: "new_balance" }],
  };
  const natural: Expr = {
    op: "mul",
    args: [{ op: "var", name: "new_balance" }, { op: "const", value: 0.03 }],
  };
  assert.equal(exprShape(commuted), exprShape(natural));
});

test("sub-ordering preserved for non-commutative ops", () => {
  const expected = parseShape("sub(var(a), var(b))");
  assert.ok(expected);
  const flipped: Expr = {
    op: "sub",
    args: [{ op: "var", name: "b" }, { op: "var", name: "a" }],
  };
  assert.ok(!shapesMatch(expected!, exprToShapeNode(flipped)));
});

test("partyMatches resolves role-based expected against party-id actual", () => {
  const parties: Party[] = [
    { id: "party-credit_union", role: "issuer", name: "WesTex CCU" },
    { id: "party-cardholder", role: "cardholder", name: "Cardholder" },
  ];
  assert.ok(partyMatches("cardholder", "party-cardholder", parties));
  assert.ok(partyMatches("issuer", "party-credit_union", parties));
  assert.ok(!partyMatches("cardholder", "party-credit_union", parties));
});

test("partyMatches rejects when party-id has no registered entry", () => {
  const parties: Party[] = [
    { id: "party-cardholder", role: "cardholder", name: "Cardholder" },
  ];
  assert.ok(!partyMatches("issuer", "party-unknown", parties));
});

test("lenientNameMatches allows bidirectional substring for outputVar drift", () => {
  assert.ok(lenientNameMatches("minimum_payment_due", "minimum_payment"));
  assert.ok(lenientNameMatches("minimum_payment", "minimum_payment_due"));
  assert.ok(!lenientNameMatches("apr_nominal", "minimum_payment"));
});

test("lenientNameMatches normalizes camel vs snake case", () => {
  assert.ok(lenientNameMatches("annualBaseSalary", "then_applicable_annual_base_salary"));
  assert.ok(lenientNameMatches("grossOfferingProceeds", "aggregate_gross_offering_proceeds"));
});

test("partyMatches treats any_party / either_party / all_parties as synonyms", () => {
  const parties: Party[] = [];
  assert.ok(partyMatches("any_party", "either_party", parties));
  assert.ok(partyMatches("all_parties", "each_party", parties));
  assert.ok(!partyMatches("cardholder", "either_party", parties));
});

test("proseOverlapMatches survives paraphrase and morphology", () => {
  assert.ok(
    proseOverlapMatches(
      "refrain from soliciting customers",
      "not directly or indirectly solicit any customer of the Company",
    ),
  );
  assert.ok(
    !proseOverlapMatches("pay invoice within 10 days", "deliver equipment by 2026-03-15"),
  );
});

test("durationsEquivalent collapses 12 months ≡ 365 calendar_days", () => {
  assert.ok(durationsEquivalent({ type: "months", value: 12 }, { type: "calendar_days", value: 365 }));
  assert.ok(durationsEquivalent({ type: "years", value: 1 }, { type: "months", value: 12 }));
  assert.ok(!durationsEquivalent({ type: "months", value: 1 }, { type: "calendar_days", value: 365 }));
});

test("shapesMatch applies lenient var-name matching inside exprShape", () => {
  const expected = parseShape("mul(const(0.03), var(grossOfferingProceeds))");
  assert.ok(expected);
  const actual: Expr = {
    op: "mul",
    args: [{ op: "const", value: 0.03 }, { op: "var", name: "aggregate_gross_offering_proceeds" }],
  };
  assert.ok(shapesMatch(expected!, exprToShapeNode(actual)));
});
