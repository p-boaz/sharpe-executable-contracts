import { createHash } from "node:crypto";
import { z } from "zod";
import { callOpenAIJson } from "../llm/openai-json.js";
import { executeContract } from "../core/executor.js";
import type { ContractIR } from "../types/ir.js";
import type { Scenario } from "../types/scenario.js";
import {
  archetypesFor,
  contractFamily,
  type Archetype,
  type ContractFamily,
} from "./archetypes.js";
import { validateArchetype } from "./archetype-check.js";

export interface GenerateScenarioOptions {
  ir: ContractIR;
  contractText: string;
  archetype: Archetype;
}

export interface GenerateAllScenariosOptions {
  ir: ContractIR;
  contractText: string;
}

const SCENARIO_CONTRACT_PROMPT_CHAR_LIMIT = 12000;
const MAX_SCENARIO_ATTEMPTS = 3;

const ScenarioSchema = z.object({
  scenarioId: z.string().min(1),
  assumptions: z.array(z.string()),
  initialState: z.record(z.string(), z.unknown()),
  events: z.array(
    z.object({
      id: z.string().min(1),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      type: z.enum([
        "purchase",
        "cash_advance",
        "payment",
        "statement_close",
        "due_check",
        "notice",
      ]),
      amount: z.number().finite().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});

const scenarioJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["scenarioId", "assumptions", "initialState", "events"],
  properties: {
    scenarioId: { type: "string" },
    assumptions: { type: "array", items: { type: "string" } },
    initialState: {
      type: "object",
      additionalProperties: {
        anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
      },
    },
    events: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "date", "type"],
        properties: {
          id: { type: "string" },
          date: { type: "string" },
          type: {
            type: "string",
            enum: [
              "purchase",
              "cash_advance",
              "payment",
              "statement_close",
              "due_check",
              "notice",
            ],
          },
          amount: { type: "number" },
          metadata: {
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
  },
};

function hashContractText(contractText: string): string {
  return createHash("sha256").update(contractText).digest("hex");
}

function contractPromptContext(contractText: string): {
  contractForPrompt: string;
  promptTruncated: boolean;
} {
  if (contractText.length <= SCENARIO_CONTRACT_PROMPT_CHAR_LIMIT) {
    return { contractForPrompt: contractText, promptTruncated: false };
  }
  return {
    contractForPrompt: contractText.slice(0, SCENARIO_CONTRACT_PROMPT_CHAR_LIMIT),
    promptTruncated: true,
  };
}

function tagScenario(
  scenario: Scenario,
  archetype: Archetype,
  contractText: string,
  promptTruncated: boolean,
  validationNote?: string,
): Scenario {
  return {
    ...scenario,
    archetype: archetype.id,
    label: archetype.label,
    metadata: {
      generation: {
        llmRequested: true,
        llmUsed: true,
        mode: "llm",
        archetype: archetype.id,
        contractHash: hashContractText(contractText),
        contractChars: contractText.length,
        promptTruncated,
        ...(validationNote ? { validationNote } : {}),
      },
    },
  };
}

function normalizeScenario(raw: unknown): Scenario {
  const parsed = ScenarioSchema.parse(raw);
  return {
    ...parsed,
    events: [...parsed.events]
      .map((event) => {
        const base = {
          id: event.id,
          date: event.date,
          type: event.type,
        } as Scenario["events"][number];
        if (typeof event.amount === "number") base.amount = event.amount;
        if (event.metadata) base.metadata = event.metadata;
        return base;
      })
      .sort((a, b) => {
        const dateCompare = a.date.localeCompare(b.date);
        if (dateCompare !== 0) return dateCompare;
        return a.id.localeCompare(b.id);
      }),
  };
}

function checkScenario(
  scenario: Scenario,
  archetype: Archetype,
  ir: ContractIR,
): string | null {
  try {
    const execution = executeContract(ir, scenario);
    return validateArchetype(scenario, archetype, execution, ir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `executor threw (${message})`;
  }
}

export interface ScenarioPromptInputs {
  ir: ContractIR;
  contractText: string;
  contractForPrompt: string;
  promptTruncated: boolean;
  archetype: Archetype;
  family: ContractFamily;
  attempt: number;
  maxAttempts: number;
  previousCandidate: Scenario | null;
  lastFailure: string | null;
}

export const SCENARIO_SYSTEM_PROMPT =
  "Generate one concrete execution scenario from contract markdown and extracted IR. Return strict JSON only. The scenario must be human-inspectable, include explicit assumptions, and satisfy every requirement listed in the user prompt. When the user prompt provides modeled obligation clause ids, bind performing events to the right id by setting event.metadata.clauseId to the exact id string; the downstream executor uses this as its primary match rule.";

export function buildScenarioUserPrompt(inputs: ScenarioPromptInputs): string {
  const {
    ir,
    contractText,
    contractForPrompt,
    promptTruncated,
    archetype,
    family,
    attempt,
    maxAttempts,
    previousCandidate,
    lastFailure,
  } = inputs;

  const modeledObligationIds = ir.clauses
    .filter((c) => c.modeled && c.effect.kind === "obligation")
    .map((c) => c.id);

  const requirements = scenarioRequirements(archetype, family);

  const bindingGuidance =
    modeledObligationIds.length > 0
      ? [
          "Binding events to obligations:",
          "- Each event that performs a modeled obligation MUST set `metadata.clauseId` to one of the ids below.",
          "- The executor's matcher uses `event.metadata.clauseId === obligation.id` as its primary rule; without it, the event will not satisfy the obligation.",
          "- Modeled obligation clause ids (pick from these exactly):",
          ...modeledObligationIds.map((id) => `  - ${id}`),
          "- If the contract's obligations cannot be performed inside this archetype's narrative, include the obligations anyway with events that reference them, but mark in `assumptions` why the archetype treats them as unmet.",
        ].join("\n")
      : "";

  const repairSection =
    previousCandidate == null
      ? ""
      : [
          "",
          `Previous candidate failed validation: ${lastFailure}`,
          "Previous candidate JSON:",
          JSON.stringify(previousCandidate),
          "Return a corrected scenario that fixes the failure.",
        ].join("\n");

  return [
    `Archetype: ${archetype.label} (${archetype.id})`,
    `Intent: ${archetype.intent}`,
    `Family: ${family}`,
    `Attempt: ${attempt}/${maxAttempts}`,
    "Validation requirements:",
    ...requirements.map((rule) => `- ${rule}`),
    ...(bindingGuidance ? ["", bindingGuidance] : []),
    `Contract hash: ${hashContractText(contractText)}`,
    `Contract prompt truncated: ${String(promptTruncated)}`,
    "",
    `Contract markdown${promptTruncated ? " (truncated excerpt)" : ""}:`,
    contractForPrompt,
    "",
    "IR JSON:",
    JSON.stringify(ir),
    repairSection,
  ].join("\n");
}

function scenarioRequirements(archetype: Archetype, family: ContractFamily): string[] {
  if (family === "credit_card" && archetype.id === "late-payment") {
    return [
      "initialState.dueDate must be a YYYY-MM-DD string.",
      "Include at least one payment event dated after initialState.dueDate.",
      "Include due_check and statement_close events.",
    ];
  }
  if (family === "credit_card" && archetype.id === "over-limit") {
    return [
      "initialState.creditLimit must be numeric.",
      "Sum of purchase event amounts must exceed initialState.creditLimit.",
      "Include a statement_close event.",
    ];
  }
  if (family === "credit_card" && archetype.id === "on-time") {
    return [
      "initialState.dueDate must be a YYYY-MM-DD string.",
      "All payment events must be on/before initialState.dueDate.",
      "Include due_check and statement_close events.",
    ];
  }
  if (family === "lease" && archetype.id === "partial-payment") {
    return [
      "initialState.monthlyRent must be numeric.",
      "Payment total must be greater than 0 and less than initialState.monthlyRent.",
      "Include a due_check event.",
    ];
  }
  if (family === "lease" && archetype.id === "on-time") {
    return [
      "initialState.monthlyRent must be numeric.",
      "initialState.rentDueDate must be a YYYY-MM-DD string.",
      "Payment total must be at least initialState.monthlyRent with no payment after rentDueDate.",
      "Include a due_check event.",
    ];
  }
  return [
    "Include at least one event that can fire a modeled clause in execution.",
  ];
}

export async function generateScenario(
  options: GenerateScenarioOptions,
): Promise<Scenario> {
  const { ir, contractText, archetype } = options;
  const family = contractFamily(ir);

  const { contractForPrompt, promptTruncated } = contractPromptContext(contractText);

  const systemPrompt = SCENARIO_SYSTEM_PROMPT;
  let lastFailure: string | null = null;
  let previousCandidate: Scenario | null = null;

  for (let attempt = 1; attempt <= MAX_SCENARIO_ATTEMPTS; attempt += 1) {
    const userPrompt = buildScenarioUserPrompt({
      ir,
      contractText,
      contractForPrompt,
      promptTruncated,
      archetype,
      family,
      attempt,
      maxAttempts: MAX_SCENARIO_ATTEMPTS,
      previousCandidate,
      lastFailure,
    });

    let llmScenario: Scenario;
    try {
      const llmResult = await callOpenAIJson<unknown>({
        systemPrompt,
        userPrompt,
        schema: scenarioJsonSchema,
      });
      llmScenario = normalizeScenario(llmResult);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Scenario generation failed for archetype ${archetype.id} in LLM-required mode: ${message}`,
      );
    }

    const llmFailure = checkScenario(llmScenario, archetype, ir);
    if (!llmFailure) {
      return tagScenario(llmScenario, archetype, contractText, promptTruncated);
    }

    lastFailure = llmFailure;
    previousCandidate = llmScenario;
  }

  throw new Error(
    `Scenario generation produced invalid executable data for archetype ${archetype.id} after ${MAX_SCENARIO_ATTEMPTS} LLM attempts: ${lastFailure ?? "unknown validation failure"}`,
  );
}

export async function generateAllScenarios(
  options: GenerateAllScenariosOptions,
): Promise<{ family: ContractFamily; scenarios: Scenario[] }> {
  const family = contractFamily(options.ir);
  const archetypes = archetypesFor(family);
  const scenarios: Scenario[] = [];
  for (const archetype of archetypes) {
    scenarios.push(
      await generateScenario({
        ir: options.ir,
        contractText: options.contractText,
        archetype,
      }),
    );
  }
  return { family, scenarios };
}
