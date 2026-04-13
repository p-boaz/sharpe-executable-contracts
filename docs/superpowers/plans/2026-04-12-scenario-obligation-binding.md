# Scenario → Obligation Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LLM-generated scenarios bind events to IR obligations via `metadata.clauseId`, and enforce that at least one modeled obligation is actually satisfied by the scenario's events, so the generic executor produces meaningful "met"/"missed" outcomes instead of marking every obligation breached.

**Architecture:** The matcher at `src/core/match-obligation.ts:69` already honors `event.metadata.clauseId === obligation.id` as its highest-priority rule. What's missing is (a) the scenario-generation prompt never tells the LLM to emit `clauseId`, (b) the baseline archetype validator only checks that *any* modeled clauseId appears in the ledger — which is trivially true because the executor emits `stmt-{clauseId}` rows for every obligation whether matched or not. We fix the prompt, fix the validator, and let the existing 3-attempt validate-retry loop in `generateScenario` enforce the new contract.

**Tech Stack:** TypeScript, node:test, zod, OpenAI JSON mode (existing `callOpenAIJson`), pnpm.

---

## File Structure

| File | Responsibility | Action |
| --- | --- | --- |
| `src/pipeline/archetype-check.ts` | Archetype post-conditions on execution | Modify (tighten baseline branch) |
| `src/pipeline/generate-scenario.ts` | Scenario prompt + validation loop | Modify (prompt + schema + requirements) |
| `tests/archetype-check.test.ts` | Unit tests for `validateArchetype` | Modify (add baseline cases) |
| `tests/scenario-binding.test.ts` | End-to-end binding contract test | Create |
| `tests/generate-scenario-prompt.test.ts` | Prompt-content regression tests | Create |

Each file's responsibility is unchanged; we add rules, not layers.

## Design decisions locked in

- **`metadata.clauseId` is the primary binding mechanism.** The IR extractor currently emits generic `actor: "party"` and `action: "Perform obligation"` for many obligations, so the actor+verb+window fallback is unreliable. Explicit `clauseId` is the only path we can depend on today. Improving IR extraction so the fallback works is explicitly **out of scope** for this plan — it's a follow-up.
- **Validation is conditional on IR having modeled obligations.** Contracts with zero modeled obligations (pure formula/payment contracts) must not fail the new baseline check.
- **No retries bump.** The existing 3-attempt validate-retry in `generateScenario` is the only retry path. If three attempts still produce an unbindable scenario, we surface the error loudly — don't quietly downgrade.
- **No schema-level enumeration of clause IDs.** Clause IDs are dynamic; we list them in the prompt and trust the LLM to pick from the list, rather than embedding them in a JSON Schema `enum`.

---

## Task 1: Tighten baseline archetype validator

**Why first:** This is the post-condition that makes the rest of the plan enforceable. Without this, the scenario generator's `checkScenario()` call can't detect unbound scenarios, so prompt changes have no teeth.

**Files:**
- Modify: `src/pipeline/archetype-check.ts:126-136`
- Modify: `tests/archetype-check.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/archetype-check.test.ts`:

```typescript
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
```

Add the imports needed at the top of the test file (if not already present):

```typescript
import type { ExecutionResult } from "../src/types/execution.js";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec tsx --test tests/archetype-check.test.ts`
Expected: the three new tests fail (the `rejects...` test will fail because the current baseline validator *passes* when any clauseId appears in the ledger).

- [ ] **Step 3: Implement the fix**

Replace the baseline branch in `src/pipeline/archetype-check.ts:126-136` with:

```typescript
  if (archetype.id === "baseline") {
    const modeledClauses = ir.clauses.filter((c) => c.modeled);
    const modeledIds = new Set(modeledClauses.map((c) => c.id));
    const modeledFired = execution.ledger.some(
      (e) => typeof e.clauseId === "string" && modeledIds.has(e.clauseId),
    );
    if (!modeledFired) {
      return "baseline archetype requires at least one modeled clause to fire in execution";
    }

    const hasObligations = modeledClauses.some((c) => c.effect.kind === "obligation");
    if (hasObligations) {
      const metObligations = execution.obligations.filter((o) => o.status === "met");
      if (metObligations.length === 0) {
        return "baseline archetype requires at least one modeled obligation to be met in execution (bind an event via metadata.clauseId)";
      }
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec tsx --test tests/archetype-check.test.ts`
Expected: all tests pass. Also run the generic-executor test to make sure it still passes:
Run: `pnpm exec tsx --test tests/generic-executor.test.ts`
Expected: all 8 tests pass (the existing procurement-shaped IR test has one met obligation, so the tightened validator is satisfied when that scenario is validated as baseline).

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/archetype-check.ts tests/archetype-check.test.ts
git commit -m "fix(archetype-check): baseline requires ≥1 met obligation when IR has obligations"
```

---

## Task 2: List modeled obligation IDs in the scenario prompt

**Why:** Giving the LLM the exact clause ID vocabulary is what unlocks successful first-attempt binding. Without this, the model invents IDs like `"8(d)(i)"` from the source text while the IR actually uses `"clause.obligation.deliver_goods"` — the two never match.

**Files:**
- Modify: `src/pipeline/generate-scenario.ts:217-289`
- Create: `tests/generate-scenario-prompt.test.ts`

- [ ] **Step 1: Refactor the prompt builder out for testability**

In `src/pipeline/generate-scenario.ts`, add a new exported helper *above* `generateScenario` (around line 216). This is the same prompt fragments `generateScenario` uses, pulled out so we can test them without calling the LLM:

```typescript
export interface ScenarioPromptInputs {
  ir: ContractIR;
  contractText: string;
  contractForPrompt: string;
  promptTruncated: boolean;
  archetype: Archetype;
  family: ContractFamily;
  attempt: number;
  maxAttempts: number;
  previousCandidate: Scenario | null;
  lastFailure: string | null;
}

export function buildScenarioUserPrompt(inputs: ScenarioPromptInputs): string {
  const {
    ir,
    contractText,
    contractForPrompt,
    promptTruncated,
    archetype,
    family,
    attempt,
    maxAttempts,
    previousCandidate,
    lastFailure,
  } = inputs;

  const modeledObligationIds = ir.clauses
    .filter((c) => c.modeled && c.effect.kind === "obligation")
    .map((c) => c.id);

  const requirements = scenarioRequirements(archetype, family);

  const bindingGuidance = modeledObligationIds.length > 0
    ? [
        "Binding events to obligations:",
        "- Each event that performs a modeled obligation MUST set `metadata.clauseId` to one of the ids below.",
        "- The executor's matcher uses `event.metadata.clauseId === obligation.id` as its primary rule; without it, the event will not satisfy the obligation.",
        "- Modeled obligation clause ids (pick from these exactly):",
        ...modeledObligationIds.map((id) => `  - ${id}`),
        "- If the contract's obligations cannot be performed inside this archetype's narrative, include the obligations anyway with events that reference them, but mark in `assumptions` why the archetype treats them as unmet.",
      ].join("\n")
    : "";

  const repairSection = previousCandidate == null
    ? ""
    : [
        "",
        `Previous candidate failed validation: ${lastFailure}`,
        "Previous candidate JSON:",
        JSON.stringify(previousCandidate),
        "Return a corrected scenario that fixes the failure.",
      ].join("\n");

  return [
    `Archetype: ${archetype.label} (${archetype.id})`,
    `Intent: ${archetype.intent}`,
    `Family: ${family}`,
    `Attempt: ${attempt}/${maxAttempts}`,
    "Validation requirements:",
    ...requirements.map((rule) => `- ${rule}`),
    ...(bindingGuidance ? ["", bindingGuidance] : []),
    `Contract hash: ${hashContractText(contractText)}`,
    `Contract prompt truncated: ${String(promptTruncated)}`,
    "",
    `Contract markdown${promptTruncated ? " (truncated excerpt)" : ""}:`,
    contractForPrompt,
    "",
    "IR JSON:",
    JSON.stringify(ir),
    repairSection,
  ].join("\n");
}

export const SCENARIO_SYSTEM_PROMPT =
  "Generate one concrete execution scenario from contract markdown and extracted IR. Return strict JSON only. The scenario must be human-inspectable, include explicit assumptions, and satisfy every requirement listed in the user prompt. When the user prompt provides modeled obligation clause ids, bind performing events to the right id by setting event.metadata.clauseId to the exact id string; the downstream executor uses this as its primary match rule.";
```

- [ ] **Step 2: Wire the helper into `generateScenario`**

Replace the inline `systemPrompt`/`userPrompt` construction in `generateScenario` (currently lines 225–260) with:

```typescript
  const systemPrompt = SCENARIO_SYSTEM_PROMPT;
  let lastFailure: string | null = null;
  let previousCandidate: Scenario | null = null;

  for (let attempt = 1; attempt <= MAX_SCENARIO_ATTEMPTS; attempt += 1) {
    const userPrompt = buildScenarioUserPrompt({
      ir,
      contractText,
      contractForPrompt,
      promptTruncated,
      archetype,
      family,
      attempt,
      maxAttempts: MAX_SCENARIO_ATTEMPTS,
      previousCandidate,
      lastFailure,
    });
```

Keep the rest of the loop body (callOpenAIJson, normalize, checkScenario, repair) unchanged.

- [ ] **Step 3: Write prompt regression tests**

Create `tests/generate-scenario-prompt.test.ts`:

```typescript
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
  assert.ok(!/clause\.formula\.total/.test(prompt.split("Binding events to obligations:")[1] ?? ""),
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
```

- [ ] **Step 4: Run the prompt tests**

Run: `pnpm exec tsx --test tests/generate-scenario-prompt.test.ts`
Expected: 4/4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/generate-scenario.ts tests/generate-scenario-prompt.test.ts
git commit -m "feat(scenario-gen): list modeled obligation ids + instruct metadata.clauseId binding in prompt"
```

---

## Task 3: Strengthen `scenarioRequirements` for the generic archetype

**Why:** The in-prompt requirements list is what the repair loop feeds back when a candidate fails. Giving it a concrete binding rule makes the retry deterministic instead of hopeful.

**Files:**
- Modify: `src/pipeline/generate-scenario.ts:175-215`
- Modify: `tests/generate-scenario-prompt.test.ts` (add one test)

- [ ] **Step 1: Write the failing test**

Append to `tests/generate-scenario-prompt.test.ts`:

```typescript
import { scenarioRequirements } from "../src/pipeline/generate-scenario.js";

test("scenarioRequirements for generic baseline requires metadata.clauseId binding", () => {
  const rules = scenarioRequirements(
    { id: "baseline", label: "Baseline review", intent: "" },
    "generic",
  );
  assert.ok(
    rules.some((r) => /metadata\.clauseId/.test(r)),
    `expected a rule mentioning metadata.clauseId, got: ${JSON.stringify(rules)}`,
  );
  assert.ok(
    rules.some((r) => /obligation/.test(r)),
    `expected a rule referencing obligations, got: ${JSON.stringify(rules)}`,
  );
});
```

- [ ] **Step 2: Export `scenarioRequirements` and update the generic branch**

In `src/pipeline/generate-scenario.ts`, change the declaration at line 175 from `function scenarioRequirements(...)` to `export function scenarioRequirements(...)`, and replace the generic fallback `return [...]` at the end of the function with:

```typescript
  if (archetype.id === "baseline") {
    return [
      "Include at least one event that performs a modeled obligation clause (set metadata.clauseId to the obligation's clause id exactly as listed in the binding guidance below).",
      "If no obligations are modeled, include at least one event that fires a modeled formula, payment, or accumulation clause.",
      "Keep the timeline minimal: prefer 1–5 events, each with a real YYYY-MM-DD date.",
    ];
  }
  return [
    "Include at least one event that can fire a modeled clause in execution.",
  ];
```

- [ ] **Step 3: Run the new test**

Run: `pnpm exec tsx --test tests/generate-scenario-prompt.test.ts`
Expected: 5/5 pass (the 4 existing + 1 new).

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/generate-scenario.ts tests/generate-scenario-prompt.test.ts
git commit -m "feat(scenario-gen): generic baseline requires explicit clauseId binding"
```

---

## Task 4: Document `clauseId` in the scenario JSON Schema

**Why:** OpenAI's strict JSON mode respects the schema we send. Adding `clauseId` as a documented optional key on `event.metadata` gives the model a schema-level hint in addition to the prose in the prompt. Keeping `additionalProperties: true` preserves the LLM's freedom to include domain notes.

**Files:**
- Modify: `src/pipeline/generate-scenario.ts:51-93` (the `scenarioJsonSchema` constant)

- [ ] **Step 1: Update the event.metadata sub-schema**

Replace the `metadata` entry inside the `events.items.properties` block (currently at lines 85–88) with:

```typescript
          metadata: {
            type: "object",
            additionalProperties: true,
            properties: {
              clauseId: {
                type: "string",
                description:
                  "Exact id of the IR obligation clause performed by this event. Required on events that perform a modeled obligation; the executor matches on this field as its primary rule.",
              },
              actor: {
                type: "string",
                description:
                  "Optional actor id (e.g. 'party.seller') used by the executor's fallback matcher when clauseId is absent.",
              },
            },
          },
```

- [ ] **Step 2: Run the full test suite to check nothing regresses**

Run: `pnpm exec tsx --test tests/generate-scenario-prompt.test.ts tests/archetype-check.test.ts tests/generic-executor.test.ts`
Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/generate-scenario.ts
git commit -m "feat(scenario-gen): document clauseId + actor in scenario JSON schema"
```

---

## Task 5: End-to-end binding test (no LLM)

**Why:** The preceding tasks are each a unit test of one piece. This task ties the pieces together by hand-crafting a scenario that should pass binding and executing it through the real executor + real validator, proving the contract holds end-to-end without depending on OpenAI.

**Files:**
- Create: `tests/scenario-binding.test.ts`

- [ ] **Step 1: Write the integration test**

Create `tests/scenario-binding.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the integration test**

Run: `pnpm exec tsx --test tests/scenario-binding.test.ts`
Expected: 2/2 pass.

- [ ] **Step 3: Run the full suite to catch regressions**

Run: `pnpm test`
Expected: the 11 tests that pass today continue to pass, plus the new tests from Tasks 1–5. Pre-existing unrelated failures (AND-form validators, `--no-llm` deprecated usage, decompiler determinism) remain — do not try to fix them in this plan.

- [ ] **Step 4: Commit**

```bash
git add tests/scenario-binding.test.ts
git commit -m "test(scenario-binding): hand-crafted scenarios cover met and unmet paths end-to-end"
```

---

## Task 6: Regenerate the sequa web artifacts and verify in the UI

**Why:** This is the user-visible proof that the data flow is now aligned. We burn it with a real LLM call to catch prompt issues the unit tests can't (e.g. the LLM picking a made-up clause id despite the prompt listing the real ones).

**Files:**
- Delete: `out/_web_runs/sequa-employment-agreement-2005/scenarios/`
- Delete: `out/_web_runs/sequa-employment-agreement-2005/executions/`
- Delete: `out/_web_runs/sequa-employment-agreement-2005/english.txt`

- [ ] **Step 1: Clean the stale artifacts**

```bash
rm -rf out/_web_runs/sequa-employment-agreement-2005/scenarios
rm -rf out/_web_runs/sequa-employment-agreement-2005/executions
rm -f out/_web_runs/sequa-employment-agreement-2005/english.txt
```

- [ ] **Step 2: Start the web dev server in the background**

```bash
cd web && pnpm dev
```

Wait for `Ready in ...ms`. Leave it running.

- [ ] **Step 3: Trigger scenario generation via the UI or curl**

Curl form (works without a browser):

```bash
curl -s -X POST http://localhost:3000/api/run-contract \
  -H "content-type: application/json" \
  -d '{"action":"generate-scenarios","contractKey":"sequa-employment-agreement-2005"}' \
  | jq .
```

Expected: `ok: true` in the response. If the LLM can't produce a binding scenario within 3 attempts, the response will be `{ error: "Scenario generation produced invalid executable data for archetype baseline after 3 LLM attempts: ..." }` — in that case capture the full error and iterate on the prompt (Task 2) until the model binds correctly.

- [ ] **Step 4: Inspect the generated scenario**

```bash
cat out/_web_runs/sequa-employment-agreement-2005/scenarios/baseline.json | jq '.events[] | { id, type, metadata_clauseId: .metadata.clauseId }'
```

Expected: at least one event has a non-null `metadata_clauseId` that matches an `id` in `ir.json` under a clause whose `effect.kind === "obligation"`.

- [ ] **Step 5: Run execution via the UI or curl**

```bash
curl -s -X POST http://localhost:3000/api/execute \
  -H "content-type: application/json" \
  -d '{"contractKey":"sequa-employment-agreement-2005","archetype":"baseline"}' \
  | jq '.execution.obligations | map({clauseId, status})'
```

Expected: at least one obligation has `status: "met"` (the others may still be `missed` — that's fine; the baseline archetype only needs one).

- [ ] **Step 6: Visual verification in the browser**

Open `http://localhost:3000/?contract=sequa-employment-agreement-2005`, click through Steps 1–4, and confirm:
- Step 2 shows a `baseline` card with the scenario.
- Step 3 shows at least one obligation without the red "breach" badge.
- Step 4's `english.txt` contains a line like `clause.obligation...: ... status=met`.

- [ ] **Step 7: Stop the dev server**

Ctrl-C the server in the terminal running it.

- [ ] **Step 8: Commit the regenerated artifacts**

```bash
git add out/_web_runs/sequa-employment-agreement-2005/
git commit -m "chore(web-runs): regenerate sequa artifacts with clauseId-bound events"
```

---

## Self-review checklist (run by the author after drafting)

- **Spec coverage:** The two root-cause findings from the prior debug session — (a) scenarios don't emit `metadata.clauseId`, (b) validator can't detect that — are addressed by Tasks 2–3 and Task 1 respectively. Task 4 strengthens the schema hint. Task 5 proves the contract. Task 6 dogfoods on a real held-out contract. ✓
- **Placeholder scan:** No "TBD", no "add error handling later", no "similar to above". All code blocks are complete copy-pasteable snippets. ✓
- **Type consistency:** `buildScenarioUserPrompt`, `ScenarioPromptInputs`, and `SCENARIO_SYSTEM_PROMPT` are introduced in Task 2 and referenced consistently in Tasks 2 and 3. `scenarioRequirements` is exported in Task 3 and imported in the new prompt test. ✓
- **Out of scope (documented above so the implementer doesn't drift):** fixing IR extraction so actor/action are concrete, regenerating all four web-run contracts, changing the `english.txt` aggregation (single-archetype) behavior. These are deliberately excluded.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-12-scenario-obligation-binding.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
