import { basename } from "node:path";
import { decompileIrToEnglish } from "../core/decompiler.js";
import { executeContract } from "../core/executor.js";
import { readTextFile } from "../io/fs.js";
import type { ContractIR } from "../types/ir.js";
import type { Scenario } from "../types/scenario.js";
import type { ContractFamily } from "./archetypes.js";
import { extractIr } from "./extract-ir.js";
import { generateAllScenarios } from "./generate-scenario.js";

export interface RunPipelineOptions {
  contractPath: string;
  useLlm: boolean;
}

export interface ScenarioRun {
  archetype: string;
  scenario: Scenario;
  execution: ReturnType<typeof executeContract>;
}

export interface RunPipelineResult {
  contractText: string;
  ir: ContractIR;
  english: string;
  family: ContractFamily;
  runs: ScenarioRun[];
}

export async function runPipeline(
  options: RunPipelineOptions,
): Promise<RunPipelineResult> {
  const contractText = await readTextFile(options.contractPath);
  const ir = await extractIr({
    contractText,
    sourceFile: basename(options.contractPath),
    useLlm: options.useLlm,
  });

  const { family, scenarios } = await generateAllScenarios({ ir, useLlm: options.useLlm });
  const english = decompileIrToEnglish(ir);

  const runs: ScenarioRun[] = scenarios.map((scenario) => ({
    archetype: scenario.archetype ?? scenario.scenarioId,
    scenario,
    execution: executeContract(ir, scenario),
  }));

  return { contractText, ir, english, family, runs };
}
