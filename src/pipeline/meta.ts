import { createHash } from "node:crypto";
import { basename } from "node:path";
import { stableStringify } from "../util/json.js";
import type { ContractIR } from "../types/ir.js";
import type { Scenario } from "../types/scenario.js";
import type { ContractFamily } from "./archetypes.js";
import type { ScenarioRun } from "./run-pipeline.js";

export interface StageLlmStatus {
  llmRequested: boolean;
  llmUsed: boolean;
  mode: string;
}

export interface ScenarioStage {
  archetype: string;
  status: StageLlmStatus;
}

export interface MetaScenarioSummary {
  archetype: string;
  label: string;
  scenarioId: string;
  summary?: string;
  endingBalance?: number;
  breached?: boolean;
  breachCount?: number;
}

export interface ContractMeta {
  contractId: string;
  title: string;
  family: ContractFamily | "unknown";
  sourceFile: string;
  irHash: string;
  englishHash?: string;
  generatedAt: string;
  llmMode: { required: true; reason: "on (required)" };
  stages: {
    extractIr?: StageLlmStatus;
    generateScenario?: ScenarioStage[];
    irGeneratedAt?: string;
    scenariosGeneratedAt?: string;
    englishGeneratedAt?: string;
    lastExecutedAt?: string;
  };
  scenarios: MetaScenarioSummary[];
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function slugifyContractKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function contractIdFor(ir: ContractIR, contractPath: string): string {
  // Prefer the filename slug so the on-disk layout and expectations/*.yaml
  // contractId stay deterministic. The LLM occasionally picks up stray
  // tokens from the source (contract numbers, revision codes, dates) and
  // that breaks directory/expectation matching.
  const fromFile = slugifyContractKey(basename(contractPath));
  if (fromFile) return fromFile;
  return slugifyContractKey(ir.contractId);
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

export interface BuildMetaInput {
  contractId: string;
  ir: ContractIR;
  sourceFile?: string;
  // When present, family comes from a scenarios pass; otherwise "unknown".
  family?: ContractFamily;
  runs?: ScenarioRun[];
  english?: string;
  // Prior meta to merge stage timestamps from (used when re-running a single stage over cached artifacts).
  existingMeta?: Partial<ContractMeta>;
  // Stage timestamp to stamp onto this call. Caller picks which key.
  stageTimestamp?: {
    key: "irGeneratedAt" | "scenariosGeneratedAt" | "englishGeneratedAt" | "lastExecutedAt";
    value: string;
  };
  generatedAt?: string;
}

export function buildMeta(input: BuildMetaInput): ContractMeta {
  const {
    contractId,
    ir,
    runs,
    english,
    family,
    existingMeta,
    stageTimestamp,
  } = input;
  const sourceFile = input.sourceFile ?? ir.metadata.sourceFile;
  const generatedAt = input.generatedAt ?? new Date().toISOString();

  const existingStages = existingMeta?.stages ?? {};

  const stages: ContractMeta["stages"] = {
    ...existingStages,
    extractIr: ir.metadata.extraction,
  };
  if (runs) {
    stages.generateScenario = runs.map((run) => ({
      archetype: run.archetype,
      status: scenarioStageStatus(run.scenario),
    }));
  }
  if (stageTimestamp) {
    stages[stageTimestamp.key] = stageTimestamp.value;
  }

  const scenarios: MetaScenarioSummary[] = runs
    ? runs.map((run) => ({
        archetype: run.archetype,
        label: run.scenario.label ?? run.archetype,
        scenarioId: run.scenario.scenarioId,
        ...(run.scenario.summary ? { summary: run.scenario.summary } : {}),
        endingBalance: run.execution.summary.endingBalance,
        breached: run.execution.summary.breached,
        breachCount: run.execution.breaches.length,
      }))
    : (existingMeta?.scenarios ?? []);

  const meta: ContractMeta = {
    contractId,
    title: ir.title ?? existingMeta?.title ?? contractId,
    sourceFile,
    family: family ?? (existingMeta?.family as ContractMeta["family"] | undefined) ?? "unknown",
    irHash: hashText(stableStringify(ir)),
    generatedAt,
    llmMode: { required: true, reason: "on (required)" },
    stages,
    scenarios,
  };
  if (english !== undefined) {
    meta.englishHash = hashText(english);
  } else if (existingMeta?.englishHash) {
    meta.englishHash = existingMeta.englishHash;
  }
  return meta;
}
