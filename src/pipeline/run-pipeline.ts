import { basename } from "node:path";
import { decompileIrToEnglish } from "../core/decompiler.js";
import { executeContract } from "../core/executor.js";
import { readTextFile } from "../io/fs.js";
import { extractIr } from "./extract-ir.js";
import { generateScenario } from "./generate-scenario.js";

export interface RunPipelineOptions {
  contractPath: string;
  useLlm: boolean;
}

export interface RunPipelineResult {
  contractText: string;
  ir: Awaited<ReturnType<typeof extractIr>>;
  scenario: Awaited<ReturnType<typeof generateScenario>>;
  execution: ReturnType<typeof executeContract>;
  english: string;
}

export async function runPipeline(options: RunPipelineOptions): Promise<RunPipelineResult> {
  const contractText = await readTextFile(options.contractPath);
  const ir = await extractIr({
    contractText,
    sourceFile: basename(options.contractPath),
    useLlm: options.useLlm,
  });
  const scenario = await generateScenario({ ir, useLlm: options.useLlm });
  const execution = executeContract(ir, scenario);
  const english = decompileIrToEnglish(ir);

  return {
    contractText,
    ir,
    scenario,
    execution,
    english,
  };
}
