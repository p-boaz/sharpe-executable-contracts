import { strict as assert } from "node:assert";
import test from "node:test";
import { executeContract } from "../src/core/executor.js";
import type { ContractIR } from "../src/types/ir.js";
import type { Scenario } from "../src/types/scenario.js";

const ir: ContractIR = {
  contractId: "balances-fixture",
  title: "Balances fixture",
  currency: "USD",
  jurisdiction: "NY",
  parties: [
    { id: "party-payer", name: "Payer", role: "buyer" },
    { id: "party-payee", name: "Payee", role: "seller" },
  ],
  definitions: [],
  clauses: [
    {
      id: "clause.fee",
      title: "Fee",
      sourceText: "Payer shall pay $1,000.",
      modeled: true,
      semanticTag: "fixed_fee",
      effect: {
        kind: "payment",
        payer: "party-payer",
        payee: "party-payee",
        amount: { op: "const", value: 1000 },
      },
    },
  ],
  metadata: {
    clauseCount: 1,
    modeledClauseCount: 1,
    sourceFile: "fixture",
    extractionHash: "test",
    extractorVersion: "test",
    extraction: { llmRequested: false, llmUsed: false, mode: "llm" },
  },
};

const scenario: Scenario = {
  scenarioId: "scn-balances",
  archetype: "baseline",
  label: "Balances baseline",
  summary: "Two partial payments.",
  assumptions: [],
  initialState: { contractStart: "2026-01-01" },
  events: [
    { id: "ev-1", date: "2026-01-15", type: "payment", amount: 400, metadata: { actor: "party-payer" } },
    { id: "ev-2", date: "2026-02-15", type: "payment", amount: 600, metadata: { actor: "party-payer" } },
  ],
};

test("generic executor accumulates balances and totals", () => {
  const result = executeContract(ir, scenario);
  const paymentRows = result.ledger.filter((l) => l.amount > 0);
  assert.equal(paymentRows.length >= 3, true, "expected scheduled + 2 payments in ledger");
  const last = result.ledger[result.ledger.length - 1];
  assert.equal(last.balanceAfter, 0, "fully paid should leave 0 balance");
  assert.equal(result.summary.totalPaid, 1000);
  assert.equal(result.summary.endingBalance, 0);
});
