import { basename } from "node:path";
import { decompileExecutionToEnglish } from "../core/decompiler.js";
import { executeContract } from "../core/executor.js";
import { readTextFile } from "../io/fs.js";
import type { ContractIR } from "../types/ir.js";
import type { Scenario } from "../types/scenario.js";
import type { ContractFamily } from "./archetypes.js";
import { extractIr } from "./extract-ir.js";
import { generateAllScenarios } from "./generate-scenario.js";

export interface RunPipelineOptions {
  contractPath: string;
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

interface ExtractContractResult {
  contractText: string;
  ir: ContractIR;
  sourceFile: string;
}

async function extractContract(
  options: RunPipelineOptions,
): Promise<ExtractContractResult> {
  const sourceFile = basename(options.contractPath);
  const contractText = await readTextFile(options.contractPath);
  const ir = await extractIr({ contractText, sourceFile });
  return { contractText, ir, sourceFile };
}

interface GenerateRunsInput {
  ir: ContractIR;
  contractText: string;
}

interface GenerateRunsResult {
  family: ContractFamily;
  runs: ScenarioRun[];
}

async function generateRuns(
  input: GenerateRunsInput,
): Promise<GenerateRunsResult> {
  const { family, scenarios } = await generateAllScenarios(input);
  const runs: ScenarioRun[] = scenarios.map((scenario) => ({
    archetype: scenario.archetype ?? scenario.scenarioId,
    scenario,
    execution: executeContract(input.ir, scenario),
  }));
  return { family, runs };
}

export async function runPipeline(
  options: RunPipelineOptions,
): Promise<RunPipelineResult> {
  const { contractText, ir } = await extractContract(options);
  const { family, runs } = await generateRuns({ ir, contractText });
  const english = decompileExecutionToEnglish(ir, runs);
  return { contractText, ir, english, family, runs };
}
