import { strict as assert } from "node:assert";
import test from "node:test";
import {
  SCENARIO_SYSTEM_PROMPT,
  buildScenarioUserPrompt,
} from "../src/pipeline/generate-scenario.js";
import type { ContractIR } from "../src/types/ir.js";

function mkIr(): ContractIR {
  return {
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
      {
        id: "clause.obligation.pay",
        title: "Pay",
        sourceText: "Buyer shall pay.",
        modeled: true,
        semanticTag: "payment_obligation",
        effect: { kind: "obligation", actor: "party.buyer", action: "Pay invoice" },
      },
      {
        id: "clause.formula.total",
        title: "Total",
        sourceText: "Total is 100.",
        modeled: true,
        semanticTag: "total",
        effect: { kind: "formula", outputVar: "total", expr: { op: "const", value: 100 } },
      },
    ],
    metadata: {
      sourceFile: "x.md",
      extractionHash: "h",
      extractorVersion: "v",
      clauseCount: 3,
      modeledClauseCount: 3,
      extraction: { llmRequested: true, llmUsed: true, mode: "llm" },
    },
  };
}

test("system prompt instructs the model to bind events via metadata.clauseId", () => {
  assert.match(SCENARIO_SYSTEM_PROMPT, /metadata\.clauseId/);
  assert.match(SCENARIO_SYSTEM_PROMPT, /primary match rule/);
});

test("user prompt lists every modeled obligation clause id verbatim", () => {
  const prompt = buildScenarioUserPrompt({
    ir: mkIr(),
    contractText: "Some contract.",
    contractForPrompt: "Some contract.",
    promptTruncated: false,
    archetype: { id: "baseline", label: "Baseline review", intent: "" },
    family: "generic",
    attempt: 1,
    maxAttempts: 3,
    previousCandidate: null,
    lastFailure: null,
  });
  assert.match(prompt, /Binding events to obligations:/);
  assert.match(prompt, /clause\.obligation\.deliver/);
  assert.match(prompt, /clause\.obligation\.pay/);
  const afterBinding = prompt.split("Binding events to obligations:")[1] ?? "";
  const bindingSection = afterBinding.split("Contract hash:")[0] ?? "";
  assert.ok(!/clause\.formula\.total/.test(bindingSection),
    "formula clauses must not appear in the obligation-id list");
});

test("user prompt omits binding guidance when IR has no modeled obligations", () => {
  const ir = mkIr();
  const irNoObligations: ContractIR = {
    ...ir,
    clauses: ir.clauses.filter((c) => c.effect.kind !== "obligation"),
  };
  const prompt = buildScenarioUserPrompt({
    ir: irNoObligations,
    contractText: "Some contract.",
    contractForPrompt: "Some contract.",
    promptTruncated: false,
    archetype: { id: "baseline", label: "Baseline review", intent: "" },
    family: "generic",
    attempt: 1,
    maxAttempts: 3,
    previousCandidate: null,
    lastFailure: null,
  });
  assert.ok(!/Binding events to obligations/.test(prompt));
});

test("user prompt includes the repair section on retry", () => {
  const prompt = buildScenarioUserPrompt({
    ir: mkIr(),
    contractText: "Some contract.",
    contractForPrompt: "Some contract.",
    promptTruncated: false,
    archetype: { id: "baseline", label: "Baseline review", intent: "" },
    family: "generic",
    attempt: 2,
    maxAttempts: 3,
    previousCandidate: {
      scenarioId: "s",
      archetype: "baseline",
      assumptions: [],
      initialState: {},
      events: [],
    },
    lastFailure: "baseline archetype requires at least one modeled obligation to be met in execution",
  });
  assert.match(prompt, /Previous candidate failed validation:/);
  assert.match(prompt, /Return a corrected scenario/);
});
