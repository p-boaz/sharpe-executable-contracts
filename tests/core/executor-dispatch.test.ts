import { test } from "node:test";
import assert from "node:assert/strict";
import { isCreditCardScenario, isLeaseScenario } from "../../src/core/executor.js";
import type { ContractIR, Clause } from "../../src/types/ir.js";
import type { Scenario } from "../../src/types/scenario.js";

// The live LLM extractor emits section-numbered clause IDs
// (e.g. `clause.5.minimum_payment_obligation`, `clause.2a.rent_obligation`).
// The old heuristic extractor emitted fixed IDs (`clause.obligation.*`).
// Dispatch must not depend on the ID string form; semanticTag is the contract.

function mkIr(clauses: Clause[]): ContractIR {
  return {
    contractId: "t",
    title: "T",
    currency: "USD",
    parties: [],
    definitions: [],
    clauses,
    metadata: {
      sourceFile: "x.md",
      extractionHash: "h",
      extractorVersion: "v",
      clauseCount: clauses.length,
      modeledClauseCount: clauses.filter((c) => c.modeled).length,
      extraction: { llmRequested: true, llmUsed: true, mode: "llm" },
    },
  };
}

function mkScenario(contractFamily?: "lease" | "credit-card" | "generic"): Scenario {
  const state: Record<string, unknown> = {};
  if (contractFamily) state.contractFamily = contractFamily;
  return {
    scenarioId: "s",
    archetype: "on-time",
    assumptions: [],
    initialState: state,
    events: [],
  };
}

test("isCreditCardScenario matches by semanticTag, not hardcoded clause.id", () => {
  const ir = mkIr([
    {
      id: "clause.5.minimum_payment_obligation",
      title: "Minimum payment",
      sourceText: "Pay the minimum.",
      modeled: true,
      semanticTag: "minimum_payment_obligation",
      effect: {
        kind: "obligation",
        actor: "cardholder",
        action: "Pay minimum",
        due: { type: "on_date", value: "statement_due_date" },
      },
    },
  ]);
  assert.equal(isCreditCardScenario(ir, mkScenario()), true);
});

test("isCreditCardScenario returns false for IR without credit-card semanticTags", () => {
  const ir = mkIr([
    {
      id: "clause.2a.rent_obligation",
      title: "Rent",
      sourceText: "Pay rent.",
      modeled: true,
      semanticTag: "rent_obligation",
      effect: {
        kind: "obligation",
        actor: "tenant",
        action: "Pay rent",
        due: { type: "on_date", value: "first_of_month" },
      },
    },
  ]);
  assert.equal(isCreditCardScenario(ir, mkScenario()), false);
});

test("isLeaseScenario matches by rent_obligation semanticTag, not hardcoded clause.id", () => {
  const ir = mkIr([
    {
      id: "clause.2a.rent_obligation",
      title: "Monthly rent",
      sourceText: "Tenant shall pay rent.",
      modeled: true,
      semanticTag: "rent_obligation",
      effect: {
        kind: "obligation",
        actor: "tenant",
        action: "Pay monthly rent",
        due: { type: "on_date", value: "first_of_month" },
      },
    },
  ]);
  assert.equal(isLeaseScenario(ir, mkScenario()), true);
});

test("isLeaseScenario returns false without rent_obligation tag", () => {
  const ir = mkIr([
    {
      id: "clause.5.minimum_payment_obligation",
      title: "Minimum payment",
      sourceText: "Pay minimum.",
      modeled: true,
      semanticTag: "minimum_payment_obligation",
      effect: {
        kind: "obligation",
        actor: "cardholder",
        action: "Pay",
        due: { type: "on_date", value: "due_date" },
      },
    },
  ]);
  assert.equal(isLeaseScenario(ir, mkScenario()), false);
});
