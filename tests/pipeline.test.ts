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
import { extractIr } from "../src/pipeline/extract-ir.js";
import { generateScenario } from "../src/pipeline/generate-scenario.js";
import { runPipeline } from "../src/pipeline/run-pipeline.js";

const root = process.cwd();
const leasePath = resolve(root, "contracts/Galleria-Atlanta-office-lease-American-Safety-Insurance-2006.md");
const cardPath = resolve(root, "contracts/WesTex-VISA-credit-card-agreement.md");

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
    useLlm: false,
  });

  assert.ok(ir.metadata.clauseCount > 0);
  assert.ok(ir.metadata.modeledClauseCount > 0);
  assert.ok(ir.metadata.modeledClauseCount < ir.metadata.clauseCount);
  assert.ok(ir.clauses.some((clause) => clause.modeled === false));
  assert.ok(ir.clauses.every((clause) => clause.sourceSpan != null));
});

test("scenario generation is IR-responsive and explicit", async () => {
  const contractText = readFileSync(cardPath, "utf8");
  const ir = await extractIr({
    contractText,
    sourceFile: "WesTex-VISA-credit-card-agreement.md",
    useLlm: false,
  });
  const scenario = await generateScenario({ ir, useLlm: false });

  assert.equal(scenario.scenarioId, "scenario.credit-card.ir-responsive");
  assert.equal(scenario.initialState.contractFamily, "credit_card");
  assert.ok(Array.isArray(scenario.assumptions));
  assert.ok(scenario.assumptions.length >= 3);
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
        kind: "obligation" as const,
        actor: "tenant",
        action: "Pay monthly rent",
        due: { type: "on_date" as const, value: "first_day_of_month" },
        condition: { op: "eq" as const, left: "rent_cycle_active", right: 1 },
        sourceText: "rent clause",
        modeled: true,
      },
      {
        id: "clause.formula.monthly_rent",
        title: "Monthly rent amount",
        kind: "formula" as const,
        outputVar: "monthly_rent_due",
        expr: { op: "const" as const, value: 100 },
        sourceText: "formula clause",
        modeled: true,
      },
    ],
    metadata: {
      sourceFile: "lease.md",
      extractionHash: "test",
      extractorVersion: "test",
      clauseCount: 2,
      modeledClauseCount: 2,
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
  const result = await runPipeline({ contractPath: cardPath, useLlm: false });
  const a = decompileIrToEnglish(result.ir);
  const b = decompileIrToEnglish(result.ir);
  assert.equal(a, b);
});

test("run command writes expected artifacts", () => {
  const outDir = mkdtempSync(join(tmpdir(), "sharpe-test-run-"));
  try {
    execFileSync(
      "pnpm",
      ["-s", "run", "run", "--contract", "contracts/WesTex-VISA-credit-card-agreement.md", "--out", outDir],
      { cwd: root, stdio: "pipe" },
    );
    assert.ok(existsSync(join(outDir, "ir.json")));
    assert.ok(existsSync(join(outDir, "scenario.json")));
    assert.ok(existsSync(join(outDir, "execution.json")));
    assert.ok(existsSync(join(outDir, "english.txt")));
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
        "--no-llm",
        "--out",
        outDir,
      ],
      { cwd: root, stdio: "pipe" },
    );

    const determinism = JSON.parse(readFileSync(join(outDir, "determinism.json"), "utf8")) as {
      irStable: boolean | null;
      scenarioStable: boolean | null;
      executionStable: boolean;
      englishStable: boolean;
      llmMode: boolean;
      comparedArtifacts: string[];
    };
    assert.equal(determinism.llmMode, false);
    assert.equal(determinism.irStable, true);
    assert.equal(determinism.scenarioStable, true);
    assert.equal(determinism.executionStable, true);
    assert.equal(determinism.englishStable, true);
    assert.deepEqual(determinism.comparedArtifacts, [
      "ir",
      "scenario",
      "execution",
      "english",
    ]);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
