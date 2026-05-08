import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { decompileIrToEnglish } from "../src/core/decompiler.js";
import { evaluateBoolExpr } from "../src/core/eval-bool.js";
import { evaluateExpr } from "../src/core/eval-expr.js";
import { executeContract } from "../src/core/executor.js";
import { archetypesFor, contractFamily } from "../src/pipeline/archetypes.js";
import { extractIr } from "../src/pipeline/extract-ir.js";
import {
  generateAllScenarios,
  generateScenario,
} from "../src/pipeline/generate-scenario.js";
import { runPipeline } from "../src/pipeline/run-pipeline.js";

const root = process.cwd();
const leasePath = resolve(root, "contracts/Galleria-Atlanta-office-lease-American-Safety-Insurance-2006.md");
const cardPath = resolve(root, "contracts/WesTex-VISA-credit-card-agreement.md");

// LLM-dependent tests use the recorded-fixture mode built into
// src/llm/openai-json.ts: with no OPENAI_API_KEY set they run in replay
// mode against tests/fixtures/llm/. To re-record after a prompt or
// extractor change, run: LLM_RECORD_MODE=record OPENAI_API_KEY=... pnpm test

test("expression evaluator supports arithmetic and variable lookup", () => {
  const value = evaluateExpr(
    {
      op: "max",
      args: [
        {
          op: "mul",
          args: [{ op: "var", name: "new_balance" }, { op: "const", value: 0.03 }],
        },
        { op: "const", value: 15 },
      ],
    },
    { new_balance: 400 },
  );
  assert.equal(value, 15);
});

test("bool evaluator supports variable conditions", () => {
  assert.equal(
    evaluateBoolExpr({ op: "eq", left: "rent_cycle_active", right: 1 }, { rent_cycle_active: 1 }),
    true,
  );
  assert.equal(
    evaluateBoolExpr({ op: "eq", left: "rent_cycle_active", right: 1 }, { rent_cycle_active: 0 }),
    false,
  );
});

test("extractor returns honest modeled/unmodeled mix on lease sample", async () => {
  const contractText = readFileSync(leasePath, "utf8");
  const ir = await extractIr({
    contractText,
    sourceFile: "Galleria-Atlanta-office-lease-American-Safety-Insurance-2006.md",
  });

  assert.ok(ir.metadata.clauseCount > 0);
  assert.ok(ir.metadata.modeledClauseCount > 0);
  assert.ok(ir.metadata.modeledClauseCount < ir.metadata.clauseCount);
  assert.ok(ir.clauses.some((clause) => clause.modeled === false));
  // Honest-posture: sourceSpan attaches when the LLM's sourceText appears
  // verbatim in the markdown. The LLM often paraphrases, so coverage varies.
  // The test invariant is that attachSourceSpans is wired (≥1 span attached),
  // not that every clause gets one.
  const withSpan = ir.clauses.filter((c) => c.sourceSpan != null).length;
  assert.ok(withSpan >= 1, "expected attachSourceSpans to attach at least one span");
});

test("scenario generation is archetype-driven and IR-responsive", async () => {
  const contractText = readFileSync(cardPath, "utf8");
  const ir = await extractIr({
    contractText,
    sourceFile: "WesTex-VISA-credit-card-agreement.md",
  });

  const family = contractFamily(ir);
  assert.equal(family, "credit_card");
  const archetypes = archetypesFor(family);
  assert.deepEqual(
    archetypes.map((a) => a.id),
    ["on-time", "late-payment", "over-limit"],
  );

  const late = archetypes.find((a) => a.id === "late-payment");
  assert.ok(late);
  const scenario = await generateScenario({
    ir,
    contractText,
    archetype: late,
  });
  assert.equal(scenario.archetype, "late-payment");
  // contractFamily is no longer stamped into initialState by the generator;
  // the executor infers family from the IR directly (see executor dispatch).
  assert.equal(scenario.metadata?.generation.archetype, "late-payment");
  assert.equal(typeof scenario.metadata?.generation.contractHash, "string");
  assert.ok(scenario.assumptions.length >= 1);

  const { scenarios } = await generateAllScenarios({ ir, contractText });
  assert.equal(scenarios.length, 3);
  assert.deepEqual(
    scenarios.map((s) => s.archetype),
    ["on-time", "late-payment", "over-limit"],
  );
});

test("executor produces different outcomes for condition true vs false", () => {
  const ir = {
    contractId: "lease-test",
    title: "Lease Test",
    currency: "USD" as const,
    parties: [{ id: "tenant", role: "tenant", name: "Tenant" }],
    definitions: [],
    clauses: [
      {
        id: "clause.obligation.monthly_rent",
        title: "Monthly rent due",
        sourceText: "rent clause",
        modeled: true,
        semanticTag: "rent_obligation",
        condition: { op: "eq" as const, left: "rent_cycle_active", right: 1 },
        effect: {
          kind: "obligation" as const,
          actor: "tenant",
          action: "Pay monthly rent",
          due: { type: "on_date" as const, value: "first_day_of_month" },
        },
      },
      {
        id: "clause.formula.monthly_rent",
        title: "Monthly rent amount",
        sourceText: "formula clause",
        modeled: true,
        semanticTag: "base_rent",
        effect: {
          kind: "formula" as const,
          outputVar: "monthly_rent_due",
          expr: { op: "const" as const, value: 100 },
        },
      },
    ],
    metadata: {
      sourceFile: "lease.md",
      extractionHash: "test",
      extractorVersion: "test",
      clauseCount: 2,
      modeledClauseCount: 2,
      extraction: {
        llmRequested: false,
        llmUsed: false,
        mode: "heuristic_fallback" as const,
      },
    },
  };

  const events = [
    { id: "evt-001", date: "2026-02-05", type: "payment" as const, amount: 60 },
    { id: "evt-002", date: "2026-02-10", type: "due_check" as const },
  ];
  const resultTrue = executeContract(ir, {
    scenarioId: "true",
    assumptions: [],
    initialState: { contractFamily: "lease", monthlyRent: 100, rent_cycle_active: 1 },
    events,
  });
  const resultFalse = executeContract(ir, {
    scenarioId: "false",
    assumptions: [],
    initialState: { contractFamily: "lease", monthlyRent: 100, rent_cycle_active: 0 },
    events,
  });

  assert.equal(resultTrue.summary.breached, true);
  assert.equal(resultFalse.summary.breached, false);
  assert.equal(resultTrue.obligations.length, 1);
  assert.equal(resultFalse.obligations.length, 0);
});

test("decompiler is deterministic for same IR", async () => {
  const result = await runPipeline({ contractPath: cardPath });
  const a = decompileIrToEnglish(result.ir);
  const b = decompileIrToEnglish(result.ir);
  assert.equal(a, b);
  assert.match(result.english, /Execution Outcomes:/);
  assert.match(result.english, /Archetype late-payment:/);
});

test("run command writes contract-keyed artifacts with archetype scenarios", () => {
  const outDir = mkdtempSync(join(tmpdir(), "sharpe-test-run-"));
  try {
    execFileSync(
      "pnpm",
      [
        "-s",
        "run",
        "run",
        "--contract",
        "contracts/WesTex-VISA-credit-card-agreement.md",
        "--out",
        outDir,
      ],
      { cwd: root, stdio: "pipe" },
    );
    assert.ok(existsSync(join(outDir, "ir.json")));
    assert.ok(existsSync(join(outDir, "english.txt")));
    assert.ok(existsSync(join(outDir, "meta.json")));
    for (const archetype of ["on-time", "late-payment", "over-limit"]) {
      assert.ok(
        existsSync(join(outDir, "scenarios", `${archetype}.json`)),
        `missing scenario for ${archetype}`,
      );
      assert.ok(
        existsSync(join(outDir, "executions", `${archetype}.json`)),
        `missing execution for ${archetype}`,
      );
    }

    const meta = JSON.parse(readFileSync(join(outDir, "meta.json"), "utf8")) as {
      contractId: string;
      family: string;
      scenarios: { archetype: string; breached: boolean }[];
    };
    assert.equal(meta.family, "credit_card");
    assert.equal(meta.scenarios.length, 3);
    const onTime = meta.scenarios.find((s) => s.archetype === "on-time");
    const latePayment = meta.scenarios.find((s) => s.archetype === "late-payment");
    assert.equal(onTime?.breached, false);
    assert.equal(latePayment?.breached, true);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("determinism command compares independent runs", () => {
  const outDir = mkdtempSync(join(tmpdir(), "sharpe-test-det-"));
  try {
    execFileSync(
      "pnpm",
      [
        "-s",
        "run",
        "determinism",
        "--contract",
        "contracts/WesTex-VISA-credit-card-agreement.md",
        "--out",
        outDir,
      ],
      { cwd: root, stdio: "pipe" },
    );

    const determinism = JSON.parse(readFileSync(join(outDir, "determinism.json"), "utf8")) as {
      englishDecompilerStable: boolean;
      englishStable: boolean;
      comparedArtifacts: string[];
    };
    // The documented guarantee: state → English is deterministic across runs.
    // IR/scenario/execution stability is intentionally left null (LLM drift).
    assert.equal(determinism.englishDecompilerStable, true);
    assert.equal(determinism.englishStable, true);
    assert.ok(determinism.comparedArtifacts.includes("english_decompiler"));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
