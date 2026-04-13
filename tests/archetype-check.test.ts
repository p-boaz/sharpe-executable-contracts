import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractIr } from "../src/pipeline/extract-ir.js";
import {
  generateScenario,
  generateAllScenarios,
} from "../src/pipeline/generate-scenario.js";
import { executeContract } from "../src/core/executor.js";
import { validateArchetype } from "../src/pipeline/archetype-check.js";
import { archetypesFor, contractFamily } from "../src/pipeline/archetypes.js";
import type { Scenario } from "../src/types/scenario.js";
import type { ContractIR } from "../src/types/ir.js";
import type { ExecutionResult } from "../src/types/execution.js";

const CC_PATH = join(
  process.cwd(),
  "contracts/WesTex-VISA-credit-card-agreement.md",
);
const LEASE_PATH = join(
  process.cwd(),
  "contracts/Galleria-Atlanta-office-lease-American-Safety-Insurance-2006.md",
);

async function scenariosFor(path: string) {
  const contractText = readFileSync(path, "utf8");
  const ir = await extractIr({ contractText, sourceFile: path, useLlm: false });
  const family = contractFamily(ir);
  const { scenarios } = await generateAllScenarios({ ir, contractText, useLlm: false });
  return { ir, family, scenarios, contractText };
}

test("credit-card deterministic fallbacks pass AND-form validation", async () => {
  const { ir, scenarios } = await scenariosFor(CC_PATH);
  const archetypes = archetypesFor("credit_card");
  for (const archetype of archetypes) {
    const scenario = scenarios.find((s) => s.archetype === archetype.id);
    assert.ok(scenario, `missing scenario for ${archetype.id}`);
    const execution = executeContract(ir, scenario!);
    const failure = validateArchetype(scenario!, archetype, execution, ir);
    assert.equal(
      failure,
      null,
      `${archetype.id} failed validation: ${failure ?? "(no reason)"}`,
    );
  }
});

test("lease deterministic fallbacks pass AND-form validation", async () => {
  const { ir, scenarios } = await scenariosFor(LEASE_PATH);
  const archetypes = archetypesFor("lease");
  for (const archetype of archetypes) {
    const scenario = scenarios.find((s) => s.archetype === archetype.id);
    assert.ok(scenario, `missing scenario for ${archetype.id}`);
    const execution = executeContract(ir, scenario!);
    const failure = validateArchetype(scenario!, archetype, execution, ir);
    assert.equal(
      failure,
      null,
      `${archetype.id} failed validation: ${failure ?? "(no reason)"}`,
    );
  }
});

test("late-payment AND-form rejects scenario with late event but no fee in ledger", async () => {
  const { ir, contractText } = await scenariosFor(CC_PATH);
  const archetypes = archetypesFor("credit_card");
  const late = archetypes.find((a) => a.id === "late-payment")!;
  const scenario = await generateScenario({ ir, contractText, archetype: late, useLlm: false });

  // Shape-only: events show lateness, but we hand the validator an empty ledger.
  const emptyExecution = {
    ledger: [],
    breaches: [],
    obligations: [],
    summary: {
      endingBalance: 0,
      totalInterestCharged: 0,
      totalFeesCharged: 0,
      totalPaid: 0,
      breached: false,
    },
  };
  const failure = validateArchetype(scenario, late, emptyExecution, ir);
  assert.ok(failure, "expected AND-form to reject shape-only pass");
  assert.match(failure!, /late-fee entry/);
});

test("over-limit AND-form rejects scenario without over-limit fee in ledger", async () => {
  const { ir, contractText } = await scenariosFor(CC_PATH);
  const archetypes = archetypesFor("credit_card");
  const overLimit = archetypes.find((a) => a.id === "over-limit")!;
  const scenario = await generateScenario({
    ir,
    contractText,
    archetype: overLimit,
    useLlm: false,
  });

  const emptyExecution = {
    ledger: [],
    breaches: [],
    obligations: [],
    summary: {
      endingBalance: 0,
      totalInterestCharged: 0,
      totalFeesCharged: 0,
      totalPaid: 0,
      breached: false,
    },
  };
  const failure = validateArchetype(scenario, overLimit, emptyExecution, ir);
  assert.ok(failure, "expected AND-form to reject shape-only over-limit pass");
  assert.match(failure!, /over-limit-fee entry/);
});

test("baseline AND-form rejects execution with no modeled clause firing", async () => {
  const { ir } = await scenariosFor(CC_PATH);
  const baseline = { id: "baseline", label: "Baseline", intent: "smoke test" };
  const emptyScenario: Scenario = {
    scenarioId: "empty",
    assumptions: [],
    initialState: {},
    events: [],
  };
  const emptyExecution = {
    ledger: [],
    breaches: [],
    obligations: [],
    summary: {
      endingBalance: 0,
      totalInterestCharged: 0,
      totalFeesCharged: 0,
      totalPaid: 0,
      breached: false,
    },
  };
  const failure = validateArchetype(emptyScenario, baseline, emptyExecution, ir);
  assert.ok(failure, "baseline must require ≥1 modeled clause firing");
  assert.match(failure!, /modeled clause/);
});

test("baseline archetype rejects execution where no obligation is met", () => {
  const ir: ContractIR = {
    contractId: "test",
    title: "Test",
    currency: "USD",
    parties: [],
    definitions: [],
    clauses: [
      {
        id: "clause.obligation.deliver",
        title: "Deliver",
        sourceText: "Seller shall deliver.",
        modeled: true,
        semanticTag: "delivery_obligation",
        effect: { kind: "obligation", actor: "party.seller", action: "Deliver goods" },
      },
    ],
    metadata: {
      sourceFile: "x.md",
      extractionHash: "h",
      extractorVersion: "v",
      clauseCount: 1,
      modeledClauseCount: 1,
      extraction: { llmRequested: true, llmUsed: true, mode: "llm" },
    },
  };
  const scenario: Scenario = {
    scenarioId: "s",
    archetype: "baseline",
    assumptions: [],
    initialState: {},
    events: [{ id: "e1", date: "2026-02-15", type: "delivery" }],
  };
  const execution: ExecutionResult = {
    ledger: [
      { id: "stmt-clause.obligation.deliver", date: "2026-02-15", kind: "statement", amount: 0, balanceAfter: 0, description: "Obligation due", clauseId: "clause.obligation.deliver" },
    ],
    obligations: [
      { id: "o1", clauseId: "clause.obligation.deliver", dueDate: "2026-02-15", amountDue: 0, amountPaid: 0, status: "missed" },
    ],
    breaches: [],
    summary: { endingBalance: 0, totalInterestCharged: 0, totalFeesCharged: 0, totalPaid: 0, breached: true },
  };
  const result = validateArchetype(
    scenario,
    { id: "baseline", label: "Baseline review", intent: "" },
    execution,
    ir,
  );
  assert.ok(result && /obligation.*met/i.test(result), `expected failure mentioning met-obligation, got: ${result}`);
});

test("baseline archetype passes when at least one obligation is met", () => {
  const ir: ContractIR = {
    contractId: "test",
    title: "Test",
    currency: "USD",
    parties: [],
    definitions: [],
    clauses: [
      {
        id: "clause.obligation.deliver",
        title: "Deliver",
        sourceText: "Seller shall deliver.",
        modeled: true,
        semanticTag: "delivery_obligation",
        effect: { kind: "obligation", actor: "party.seller", action: "Deliver goods" },
      },
    ],
    metadata: {
      sourceFile: "x.md",
      extractionHash: "h",
      extractorVersion: "v",
      clauseCount: 1,
      modeledClauseCount: 1,
      extraction: { llmRequested: true, llmUsed: true, mode: "llm" },
    },
  };
  const scenario: Scenario = {
    scenarioId: "s",
    archetype: "baseline",
    assumptions: [],
    initialState: {},
    events: [{ id: "e1", date: "2026-02-15", type: "delivery", metadata: { clauseId: "clause.obligation.deliver" } }],
  };
  const execution: ExecutionResult = {
    ledger: [
      { id: "stmt-clause.obligation.deliver", date: "2026-02-15", kind: "statement", amount: 0, balanceAfter: 0, description: "Obligation due", clauseId: "clause.obligation.deliver" },
    ],
    obligations: [
      { id: "o1", clauseId: "clause.obligation.deliver", dueDate: "2026-02-15", amountDue: 0, amountPaid: 0, status: "met" },
    ],
    breaches: [],
    summary: { endingBalance: 0, totalInterestCharged: 0, totalFeesCharged: 0, totalPaid: 0, breached: false },
  };
  assert.equal(
    validateArchetype(
      scenario,
      { id: "baseline", label: "Baseline review", intent: "" },
      execution,
      ir,
    ),
    null,
  );
});

test("baseline archetype skips met-obligation check when IR has no modeled obligations", () => {
  const ir: ContractIR = {
    contractId: "test",
    title: "Test",
    currency: "USD",
    parties: [],
    definitions: [],
    clauses: [
      {
        id: "clause.formula.apr",
        title: "APR",
        sourceText: "APR 7.9%.",
        modeled: true,
        semanticTag: "apr",
        effect: { kind: "formula", outputVar: "apr_nominal", expr: { op: "const", value: 7.9 } },
      },
    ],
    metadata: {
      sourceFile: "x.md",
      extractionHash: "h",
      extractorVersion: "v",
      clauseCount: 1,
      modeledClauseCount: 1,
      extraction: { llmRequested: true, llmUsed: true, mode: "llm" },
    },
  };
  const scenario: Scenario = {
    scenarioId: "s",
    archetype: "baseline",
    assumptions: [],
    initialState: {},
    events: [],
  };
  const execution: ExecutionResult = {
    ledger: [
      { id: "stmt-clause.formula.apr", date: "2026-01-01", kind: "statement", amount: 0, balanceAfter: 0, description: "formula", clauseId: "clause.formula.apr" },
    ],
    obligations: [],
    breaches: [],
    summary: { endingBalance: 0, totalInterestCharged: 0, totalFeesCharged: 0, totalPaid: 0, breached: false },
  };
  assert.equal(
    validateArchetype(
      scenario,
      { id: "baseline", label: "Baseline review", intent: "" },
      execution,
      ir,
    ),
    null,
  );
});
