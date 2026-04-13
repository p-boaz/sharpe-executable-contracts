import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { ensureDir, readTextFile, writeJson, writeText } from "../src/io/fs.js";
import { decompileExecutionToEnglish, type ExecutionEnglishRun } from "../src/core/decompiler.js";
import { executeContract } from "../src/core/executor.js";
import { generateAllScenarios } from "../src/pipeline/generate-scenario.js";

const [, , contractKey] = process.argv;
if (!contractKey) {
  console.error("usage: tsx scripts/regenerate-web-run.ts <contract-key>");
  process.exit(1);
}

const WEB_RUNS = resolve(process.cwd(), "out", "_web_runs", contractKey);

(async () => {
  const [contractText, irRaw] = await Promise.all([
    readTextFile(resolve(WEB_RUNS, "contract.md")),
    readTextFile(resolve(WEB_RUNS, "ir.json")),
  ]);
  const ir = JSON.parse(irRaw);

  await rm(resolve(WEB_RUNS, "scenarios"), { recursive: true, force: true });
  await rm(resolve(WEB_RUNS, "executions"), { recursive: true, force: true });
  await rm(resolve(WEB_RUNS, "english.txt"), { force: true });
  await ensureDir(resolve(WEB_RUNS, "scenarios"));
  await ensureDir(resolve(WEB_RUNS, "executions"));

  console.log(`Generating scenarios for ${contractKey}...`);
  const { family, scenarios } = await generateAllScenarios({ ir, contractText });

  const runs: ExecutionEnglishRun[] = [];
  const summaries: Array<{
    archetype: string;
    label: string;
    scenarioId: string;
    endingBalance: number;
    breached: boolean;
    breachCount: number;
  }> = [];

  for (const scenario of scenarios) {
    const archetype = scenario.archetype ?? scenario.scenarioId;
    await writeJson(resolve(WEB_RUNS, "scenarios", `${archetype}.json`), scenario);

    const execution = executeContract(ir, scenario);
    await writeJson(resolve(WEB_RUNS, "executions", `${archetype}.json`), execution);

    runs.push({ archetype, scenario, execution });
    summaries.push({
      archetype,
      label: scenario.label ?? archetype,
      scenarioId: scenario.scenarioId,
      endingBalance: execution.summary.endingBalance,
      breached: execution.summary.breached,
      breachCount: execution.breaches.length,
    });
  }

  const english = decompileExecutionToEnglish(ir, runs);
  await writeText(resolve(WEB_RUNS, "english.txt"), english);

  const metaRaw = await readTextFile(resolve(WEB_RUNS, "meta.json"));
  const meta = JSON.parse(metaRaw);
  const now = new Date().toISOString();
  meta.family = family;
  meta.stages = {
    ...(meta.stages ?? {}),
    scenariosGeneratedAt: now,
    lastExecutedAt: now,
    englishGeneratedAt: now,
  };
  meta.englishHash = createHash("sha256").update(english).digest("hex");
  meta.scenarios = summaries;
  await writeJson(resolve(WEB_RUNS, "meta.json"), meta);

  console.log(`\nSummary:`);
  for (const s of summaries) {
    console.log(
      `  ${s.archetype.padEnd(14)} endingBalance=${s.endingBalance} breached=${s.breached} breaches=${s.breachCount}`,
    );
  }
})();
