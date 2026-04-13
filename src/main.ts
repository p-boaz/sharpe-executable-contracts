import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { decompileExecutionToEnglish } from "./core/decompiler.js";
import { ensureDir, writeJson, writeText } from "./io/fs.js";
import { runPipeline, type ScenarioRun } from "./pipeline/run-pipeline.js";
import type { ContractIR } from "./types/ir.js";
import type { Scenario } from "./types/scenario.js";
import { stableStringify } from "./util/json.js";

interface CliOptions {
  command: "run" | "determinism" | "help";
  contractPath: string;
  outDir?: string;
  outRoot: string;
}

interface StageLlmStatus {
  llmRequested: boolean;
  llmUsed: boolean;
  mode: string;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.md$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function contractIdFor(ir: ContractIR, contractPath: string): string {
  const fromIr = slugify(ir.contractId);
  if (fromIr) return fromIr;
  return slugify(basename(contractPath));
}

function loadDotEnvFromCwd(): void {
  const dotEnvPath = resolve(process.cwd(), ".env");
  if (!existsSync(dotEnvPath)) return;
  const content = readFileSync(dotEnvPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim();
    if (!key || key in process.env) continue;
    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function ensureOpenAiKey(): void {
  if (process.env.OPENAI_API_KEY) return;
  throw new Error(
    "OPENAI_API_KEY is required. This repo now runs in LLM-required mode only.",
  );
}

function scenarioStageStatus(scenario: Scenario): StageLlmStatus {
  const fromScenario = scenario.metadata?.generation;
  if (fromScenario) {
    return {
      llmRequested: fromScenario.llmRequested,
      llmUsed: fromScenario.llmUsed,
      mode: fromScenario.mode,
    };
  }
  return { llmRequested: true, llmUsed: true, mode: "llm" };
}

function parseArgs(argv: string[]): CliOptions {
  const command = (argv[0] || "help") as CliOptions["command"];
  let contractPath = "contracts/WesTex-VISA-credit-card-agreement.md";
  let outRoot = "out";
  let outDir: string | undefined;

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--contract" && next) {
      contractPath = next;
      i += 1;
      continue;
    }
    if (arg === "--out" && next) {
      outDir = next;
      i += 1;
      continue;
    }
    if (arg === "--out-root" && next) {
      outRoot = next;
      i += 1;
      continue;
    }
    if (arg === "--use-llm" || arg === "--no-llm") {
      throw new Error(`${arg} is no longer supported. LLM mode is always on.`);
    }
    if (arg?.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const base = { contractPath, outRoot };
  const withOut = outDir === undefined ? base : { ...base, outDir };
  if (command !== "run" && command !== "determinism") {
    return { ...withOut, command: "help" };
  }
  return { ...withOut, command };
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage:",
      "  pnpm run run --contract <path> [--out-root <dir>] [--out <dir>]",
      "  pnpm run determinism --contract <path> [--out-root <dir>] [--out <dir>]",
      "",
      "Layout:",
      "  Default writes to <out-root>/<contractId>/ with ir.json, english.txt,",
      "  scenarios/<archetype>.json, executions/<archetype>.json, and meta.json.",
      "  --out <dir> overrides the per-contract folder (legacy flat layout).",
      "",
      "LLM mode:",
      "  OPENAI_API_KEY is required. Non-LLM mode has been removed.",
      "  .env in repo root is auto-loaded before arg parsing.",
      "",
      "Defaults:",
      "  contract: contracts/WesTex-VISA-credit-card-agreement.md",
      "  out-root: out",
    ].join("\n"),
  );
  process.stdout.write("\n");
}

async function writeContractBundle(
  contractDir: string,
  contractText: string,
  ir: ContractIR,
  english: string,
  runs: ScenarioRun[],
  meta: Record<string, unknown>,
): Promise<void> {
  await ensureDir(contractDir);
  await writeText(resolve(contractDir, "contract.md"), contractText);
  await writeJson(resolve(contractDir, "ir.json"), ir);
  await writeText(resolve(contractDir, "english.txt"), english);
  for (const run of runs) {
    await writeJson(
      resolve(contractDir, "scenarios", `${run.archetype}.json`),
      run.scenario,
    );
    await writeJson(
      resolve(contractDir, "executions", `${run.archetype}.json`),
      run.execution,
    );
  }
  await writeJson(resolve(contractDir, "meta.json"), meta);
}

async function runCommand(options: CliOptions): Promise<void> {
  const contractPath = resolve(process.cwd(), options.contractPath);
  const result = await runPipeline({ contractPath });
  const extractionStage = result.ir.metadata.extraction;
  const contractId = contractIdFor(result.ir, contractPath);

  const contractDir = options.outDir
    ? resolve(process.cwd(), options.outDir)
    : resolve(process.cwd(), options.outRoot, contractId);

  const scenarioStages = result.runs.map((run) => ({
    archetype: run.archetype,
    status: scenarioStageStatus(run.scenario),
  }));

  const irHash = hashText(stableStringify(result.ir));
  const englishHash = hashText(result.english);

  const meta = {
    contractId,
    title: result.ir.title,
    sourceFile: result.ir.metadata.sourceFile,
    family: result.family,
    irHash,
    englishHash,
    generatedAt: new Date().toISOString(),
    llmMode: {
      required: true,
      reason: "on (required)",
    },
    stages: {
      extractIr: extractionStage,
      generateScenario: scenarioStages,
    },
    scenarios: result.runs.map((run) => ({
      archetype: run.archetype,
      label: run.scenario.label ?? run.archetype,
      scenarioId: run.scenario.scenarioId,
      endingBalance: run.execution.summary.endingBalance,
      breached: run.execution.summary.breached,
      breachCount: run.execution.breaches.length,
    })),
  };

  await writeContractBundle(
    contractDir,
    result.contractText,
    result.ir,
    result.english,
    result.runs,
    meta,
  );

  const summaryLines = [
    "Command: run",
    `Contract: ${options.contractPath}`,
    `ContractId: ${contractId}`,
    `Output: ${contractDir}`,
    `Family: ${result.family}`,
    "LLM mode: on (required)",
    `IR extraction stage: ${extractionStage.mode} (llmUsed=${extractionStage.llmUsed})`,
    `Scenarios (${result.runs.length}):`,
    ...result.runs.map((run) => {
      const stage = scenarioStages.find((s) => s.archetype === run.archetype)?.status;
      const balance = run.execution.summary.endingBalance.toFixed(2);
      const breach = run.execution.summary.breached ? "BREACHED" : "ok";
      return `  - ${run.archetype}: stage=${stage?.mode ?? "?"} balance=$${balance} ${breach}`;
    }),
  ];
  process.stdout.write(summaryLines.join("\n"));
  process.stdout.write("\n");
}

function serializeRuns(runs: ScenarioRun[]): string {
  return stableStringify(
    runs.map((run) => ({
      archetype: run.archetype,
      scenario: run.scenario,
      execution: run.execution,
    })),
  );
}

async function runDeterminismCommand(options: CliOptions): Promise<void> {
  const contractPath = resolve(process.cwd(), options.contractPath);

  const resultA = await runPipeline({ contractPath });
  const resultB = await runPipeline({ contractPath });

  const contractId = contractIdFor(resultA.ir, contractPath);
  const determinismDir = options.outDir
    ? resolve(process.cwd(), options.outDir)
    : resolve(process.cwd(), options.outRoot, "_checks", "determinism", contractId);
  await ensureDir(determinismDir);

  const extractionStageA = resultA.ir.metadata.extraction;
  const extractionStageB = resultB.ir.metadata.extraction;

  const irA = stableStringify(resultA.ir);
  const irB = stableStringify(resultB.ir);
  const runsA = serializeRuns(resultA.runs);
  const runsB = serializeRuns(resultB.runs);
  const englishA = resultA.english;
  const englishB = resultB.english;
  const englishAReplay = decompileExecutionToEnglish(resultA.ir, resultA.runs);
  const englishBReplay = decompileExecutionToEnglish(resultB.ir, resultB.runs);

  const englishCrossRunStable = englishA === englishB;
  const englishDecompilerStable = englishA === englishAReplay && englishB === englishBReplay;
  const englishStable = englishDecompilerStable;

  await writeText(resolve(determinismDir, "ir-a.json"), `${irA}\n`);
  await writeText(resolve(determinismDir, "ir-b.json"), `${irB}\n`);
  await writeText(resolve(determinismDir, "runs-a.json"), `${runsA}\n`);
  await writeText(resolve(determinismDir, "runs-b.json"), `${runsB}\n`);
  await writeText(resolve(determinismDir, "english-a.txt"), englishA);
  await writeText(resolve(determinismDir, "english-b.txt"), englishB);

  const determinismArtifact: Record<string, unknown> = {
    contractId,
    comparedArtifacts: ["english_decompiler"],
    llmMode: true,
    irStable: null,
    scenarioStable: null,
    executionStable: null,
    englishStable,
    englishCrossRunStable,
    englishDecompilerStable,
    irHashA: hashText(irA),
    irHashB: hashText(irB),
    runsHashA: hashText(runsA),
    runsHashB: hashText(runsB),
    englishHashA: hashText(englishA),
    englishHashB: hashText(englishB),
    archetypes: resultA.runs.map((run) => run.archetype),
    stages: {
      extractIr: { runA: extractionStageA, runB: extractionStageB },
    },
    notes:
      "IR, scenarios, executions, and cross-run english output may vary in LLM-required mode. Determinism guarantee is executable-state -> english decompilation purity for each run.",
  };
  await writeJson(resolve(determinismDir, "determinism.json"), determinismArtifact);

  process.stdout.write(
    [
      "Command: determinism",
      `Contract: ${options.contractPath}`,
      `ContractId: ${contractId}`,
      `Output: ${determinismDir}`,
      "LLM mode: on (required)",
      `IR extraction stage: ${extractionStageA.mode} (llmUsed=${extractionStageA.llmUsed})`,
      "IR stable: n/a (LLM-required mode)",
      "Scenario stable: n/a (LLM-required mode)",
      "Execution stable: n/a (LLM-required mode)",
      `English stable: ${englishStable}`,
      "English cross-run stable: n/a (LLM-required mode)",
    ].join("\n"),
  );
  process.stdout.write("\n");
}

async function main(): Promise<void> {
  loadDotEnvFromCwd();
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "help") return printHelp();
  ensureOpenAiKey();
  if (options.command === "run") return runCommand(options);
  return runDeterminismCommand(options);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
});
