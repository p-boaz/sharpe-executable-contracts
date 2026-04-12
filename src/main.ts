import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { decompileIrToEnglish } from "./core/decompiler.js";
import { ensureDir, writeJson, writeText } from "./io/fs.js";
import { runPipeline } from "./pipeline/run-pipeline.js";
import { stableStringify } from "./util/json.js";

interface CliOptions {
  command: "run" | "determinism" | "help";
  contractPath: string;
  outDir: string;
  useLlm: boolean;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv: string[]): CliOptions {
  const command = (argv[0] || "help") as CliOptions["command"];
  let contractPath = "contracts/WesTex-VISA-credit-card-agreement.md";
  let outDir = command === "determinism" ? "out/determinism" : "out/run";
  let useLlm = false;

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
      useLlm = true;
    }
  }

  if (command !== "run" && command !== "determinism") {
    return {
      command: "help",
      contractPath,
      outDir,
      useLlm,
    };
  }

  return {
    command,
    contractPath,
    outDir,
    useLlm,
  };
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage:",
      "  pnpm run run --contract <path> --out <dir> [--use-llm]",
      "  pnpm run determinism --contract <path> --out <dir> [--use-llm]",
      "",
      "Defaults:",
      "  contract: contracts/WesTex-VISA-credit-card-agreement.md",
      "  out(run): out/run",
      "  out(determinism): out/determinism",
    ].join("\n"),
  );
  process.stdout.write("\n");
}

async function runCommand(options: CliOptions): Promise<void> {
  const contractPath = resolve(process.cwd(), options.contractPath);
  const outDir = resolve(process.cwd(), options.outDir);
  await ensureDir(outDir);

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
      `LLM mode: ${options.useLlm ? "on" : "off"}`,
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

  const result = await runPipeline({
    contractPath,
    useLlm: options.useLlm,
  });

  const englishA = decompileIrToEnglish(result.ir);
  const englishB = decompileIrToEnglish(result.ir);
  const executionA = stableStringify(result.execution);
  const executionB = stableStringify(result.execution);

  const englishStable = englishA === englishB;
  const executionStable = executionA === executionB;

  await writeText(resolve(outDir, "english-a.txt"), englishA);
  await writeText(resolve(outDir, "english-b.txt"), englishB);
  await writeText(resolve(outDir, "execution-a.json"), `${executionA}\n`);
  await writeText(resolve(outDir, "execution-b.json"), `${executionB}\n`);
  await writeJson(resolve(outDir, "determinism.json"), {
    englishStable,
    executionStable,
    englishHashA: hashText(englishA),
    englishHashB: hashText(englishB),
    executionHashA: hashText(executionA),
    executionHashB: hashText(executionB),
  });

  process.stdout.write(
    [
      `Command: determinism`,
      `Contract: ${options.contractPath}`,
      `Output: ${options.outDir}`,
      `LLM mode: ${options.useLlm ? "on" : "off"}`,
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
