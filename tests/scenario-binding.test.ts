import { strict as assert } from "node:assert";
import test from "node:test";
import { executeContract } from "../src/core/executor.js";
import { validateArchetype } from "../src/pipeline/archetype-check.js";
import type { ContractIR } from "../src/types/ir.js";
import type { Scenario } from "../src/types/scenario.js";

function twoObligationIr(): ContractIR {
  return {
    contractId: "emp-test",
    title: "Employment Test",
    currency: "USD",
    parties: [
      { id: "party.employer", role: "employer", name: "Sequa" },
      { id: "party.employee", role: "employee", name: "Employee" },
    ],
    definitions: [],
    clauses: [
      {
        id: "clause.obligation.pay_salary",
        title: "Pay base salary",
        sourceText: "Company shall pay annual base salary.",
        modeled: true,
        semanticTag: "base_salary_obligation",
        effect: {
          kind: "obligation",
          actor: "party.employer",
          action: "Pay base salary",
          due: { type: "on_date", value: "2005-11-29" },
        },
      },
      {
        id: "clause.obligation.confidentiality",
        title: "Maintain confidentiality",
        sourceText: "Employee shall keep information confidential.",
        modeled: true,
        semanticTag: "confidentiality_obligation",
        effect: {
          kind: "obligation",
          actor: "party.employee",
          action: "Maintain confidentiality",
          due: { type: "on_date", value: "2006-05-31" },
        },
      },
    ],
    metadata: {
      sourceFile: "emp-test.md",
      extractionHash: "h",
      extractorVersion: "v",
      clauseCount: 2,
      modeledClauseCount: 2,
      extraction: { llmRequested: true, llmUsed: true, mode: "llm" },
    },
  };
}

test("scenario with metadata.clauseId binding produces a met obligation and passes baseline validation", () => {
  const ir = twoObligationIr();
  const scenario: Scenario = {
    scenarioId: "emp-test-baseline",
    archetype: "baseline",
    label: "Baseline review",
    assumptions: ["Company pays accrued salary on termination."],
    initialState: { contractStart: "2005-05-31" },
    events: [
      {
        id: "E1",
        date: "2005-11-29",
        type: "payment",
        amount: 7408,
        metadata: { clauseId: "clause.obligation.pay_salary" },
      },
    ],
  };

  const execution = executeContract(ir, scenario);
  const metCount = execution.obligations.filter((o) => o.status === "met").length;
  assert.equal(metCount, 1, `expected exactly one met obligation, got ${metCount}`);
  assert.ok(execution.breaches.length >= 1, "confidentiality obligation should still be missed");

  const validation = validateArchetype(
    scenario,
    { id: "baseline", label: "Baseline review", intent: "" },
    execution,
    ir,
  );
  assert.equal(validation, null, `expected validation to pass, got: ${validation}`);
});

test("scenario without metadata.clauseId fails baseline validation (no obligation reaches met)", () => {
  const ir = twoObligationIr();
  const scenario: Scenario = {
    scenarioId: "emp-test-baseline",
    archetype: "baseline",
    label: "Baseline review",
    assumptions: [],
    initialState: { contractStart: "2005-05-31" },
    events: [
      {
        id: "E1",
        date: "2005-11-29",
        type: "payment",
        amount: 7408,
      },
    ],
  };

  const execution = executeContract(ir, scenario);
  assert.equal(
    execution.obligations.filter((o) => o.status === "met").length,
    0,
    "no obligation should match without metadata.clauseId",
  );

  const validation = validateArchetype(
    scenario,
    { id: "baseline", label: "Baseline review", intent: "" },
    execution,
    ir,
  );
  assert.ok(
    validation && /metadata\.clauseId/.test(validation),
    `expected validation failure mentioning metadata.clauseId, got: ${validation}`,
  );
});
