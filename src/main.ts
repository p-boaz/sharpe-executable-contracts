import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { ensureDir, writeJson, writeText } from "./io/fs.js";
import { runPipeline } from "./pipeline/run-pipeline.js";
import { stableStringify } from "./util/json.js";

type LlmModeReason =
  | "on (OPENAI_API_KEY detected)"
  | "on (--use-llm)"
  | "off (--no-llm)"
  | "off (no OPENAI_API_KEY)";

interface CliOptions {
  command: "run" | "determinism" | "help";
  contractPath: string;
  outDir: string;
  useLlm: boolean;
  llmModeReason: LlmModeReason;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv: string[]): CliOptions {
  const command = (argv[0] || "help") as CliOptions["command"];
  let contractPath = "contracts/WesTex-VISA-credit-card-agreement.md";
  let outDir = command === "determinism" ? "out/determinism" : "out/run";
  let explicitUseLlm = false;
  let explicitNoLlm = false;

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
    if (arg === "--use-llm") {
      explicitUseLlm = true;
      continue;
    }
    if (arg === "--no-llm") {
      explicitNoLlm = true;
      continue;
    }
  }

  const hasKey = Boolean(process.env.OPENAI_API_KEY);
  let useLlm: boolean;
  let llmModeReason: LlmModeReason;
  if (explicitNoLlm) {
    useLlm = false;
    llmModeReason = "off (--no-llm)";
  } else if (explicitUseLlm) {
    useLlm = true;
    llmModeReason = "on (--use-llm)";
  } else if (hasKey) {
    useLlm = true;
    llmModeReason = "on (OPENAI_API_KEY detected)";
  } else {
    useLlm = false;
    llmModeReason = "off (no OPENAI_API_KEY)";
  }

  if (command !== "run" && command !== "determinism") {
    return {
      command: "help",
      contractPath,
      outDir,
      useLlm,
      llmModeReason,
    };
  }

  return {
    command,
    contractPath,
    outDir,
    useLlm,
    llmModeReason,
  };
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage:",
      "  pnpm run run --contract <path> --out <dir> [--use-llm | --no-llm]",
      "  pnpm run determinism --contract <path> --out <dir> [--use-llm | --no-llm]",
      "",
      "LLM mode:",
      "  defaults on when OPENAI_API_KEY is set; --no-llm forces fallback.",
      "",
      "Defaults:",
      "  contract: contracts/WesTex-VISA-credit-card-agreement.md",
      "  out(run): out/run",
      "  out(determinism): out/determinism",
    ].join("\n"),
  );
  process.stdout.write("\n");
}

const HEURISTIC_FALLBACK_BANNER =
  "Note: running without --use-llm. Heuristic fallback models credit-card and lease\n" +
  "shapes only; other contract families will degrade to honest [UNMODELED] clauses.\n" +
  "Set OPENAI_API_KEY and re-run for full extraction.\n";

async function runCommand(options: CliOptions): Promise<void> {
  const contractPath = resolve(process.cwd(), options.contractPath);
  const outDir = resolve(process.cwd(), options.outDir);
  await ensureDir(outDir);

  if (!options.useLlm) {
    process.stderr.write(HEURISTIC_FALLBACK_BANNER);
  }

  const result = await runPipeline({
    contractPath,
    useLlm: options.useLlm,
  });

  await writeText(resolve(outDir, "contract.md"), result.contractText);
  await writeJson(resolve(outDir, "ir.json"), result.ir);
  await writeJson(resolve(outDir, "scenario.json"), result.scenario);
  await writeJson(resolve(outDir, "execution.json"), result.execution);
  await writeText(resolve(outDir, "english.txt"), result.english);

  process.stdout.write(
    [
      `Command: run`,
      `Contract: ${options.contractPath}`,
      `Output: ${options.outDir}`,
      `LLM mode: ${options.llmModeReason}`,
      `Ending balance: $${result.execution.summary.endingBalance.toFixed(2)}`,
      `Breaches: ${result.execution.breaches.length}`,
    ].join("\n"),
  );
  process.stdout.write("\n");
}

async function runDeterminismCommand(options: CliOptions): Promise<void> {
  const contractPath = resolve(process.cwd(), options.contractPath);
  const outDir = resolve(process.cwd(), options.outDir);
  await ensureDir(outDir);

  if (!options.useLlm) {
    process.stderr.write(HEURISTIC_FALLBACK_BANNER);
  }

  const resultA = await runPipeline({
    contractPath,
    useLlm: options.useLlm,
  });
  const resultB = await runPipeline({
    contractPath,
    useLlm: options.useLlm,
  });

  const irA = stableStringify(resultA.ir);
  const irB = stableStringify(resultB.ir);
  const scenarioA = stableStringify(resultA.scenario);
  const scenarioB = stableStringify(resultB.scenario);
  const executionA = stableStringify(resultA.execution);
  const executionB = stableStringify(resultB.execution);
  const englishA = resultA.english;
  const englishB = resultB.english;

  const irEqual = irA === irB;
  const scenarioEqual = scenarioA === scenarioB;
  const englishStable = englishA === englishB;
  const executionStable = executionA === executionB;

  const llmMode = options.useLlm;
  const irStable: boolean | null = llmMode ? null : irEqual;
  const scenarioStable: boolean | null = llmMode ? null : scenarioEqual;
  const comparedArtifacts = llmMode
    ? ["execution", "english"]
    : ["ir", "scenario", "execution", "english"];

  await writeText(resolve(outDir, "ir-a.json"), `${irA}\n`);
  await writeText(resolve(outDir, "ir-b.json"), `${irB}\n`);
  await writeText(resolve(outDir, "scenario-a.json"), `${scenarioA}\n`);
  await writeText(resolve(outDir, "scenario-b.json"), `${scenarioB}\n`);
  await writeText(resolve(outDir, "english-a.txt"), englishA);
  await writeText(resolve(outDir, "english-b.txt"), englishB);
  await writeText(resolve(outDir, "execution-a.json"), `${executionA}\n`);
  await writeText(resolve(outDir, "execution-b.json"), `${executionB}\n`);

  const determinismArtifact: Record<string, unknown> = {
    comparedArtifacts,
    llmMode,
    irStable,
    scenarioStable,
    englishStable,
    executionStable,
    irHashA: hashText(irA),
    irHashB: hashText(irB),
    scenarioHashA: hashText(scenarioA),
    scenarioHashB: hashText(scenarioB),
    englishHashA: hashText(englishA),
    englishHashB: hashText(englishB),
    executionHashA: hashText(executionA),
    executionHashB: hashText(executionB),
  };
  if (llmMode) {
    determinismArtifact.notes =
      "IR and scenario stability are not asserted under --use-llm; the LLM path is expected to vary across runs. The executable-to-English leg is the determinism guarantee.";
  }
  await writeJson(resolve(outDir, "determinism.json"), determinismArtifact);

  const formatLegacyStability = (value: boolean | null): string =>
    value === null ? "n/a (LLM mode)" : String(value);

  process.stdout.write(
    [
      `Command: determinism`,
      `Contract: ${options.contractPath}`,
      `Output: ${options.outDir}`,
      `LLM mode: ${options.llmModeReason}`,
      `IR stable: ${formatLegacyStability(irStable)}`,
      `Scenario stable: ${formatLegacyStability(scenarioStable)}`,
      `English stable: ${englishStable}`,
      `Execution stable: ${executionStable}`,
    ].join("\n"),
  );
  process.stdout.write("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "help") {
    printHelp();
    return;
  }

  if (options.command === "run") {
    await runCommand(options);
    return;
  }

  await runDeterminismCommand(options);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
});
