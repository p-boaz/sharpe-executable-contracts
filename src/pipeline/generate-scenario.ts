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
  archetype: Archetype;
  useLlm: boolean;
}

export interface GenerateAllScenariosOptions {
  ir: ContractIR;
  useLlm: boolean;
}

type GenerationMetadata = NonNullable<Scenario["metadata"]>["generation"];
type GenerationMode = GenerationMetadata["mode"];

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

function aprFromIr(ir: ContractIR): number {
  const aprClause = ir.clauses.find(
    (c) => c.effect.kind === "formula" && c.effect.outputVar === "apr_nominal",
  );
  if (!aprClause || aprClause.effect.kind !== "formula") return 7.9;
  const expr = aprClause.effect.expr;
  if (expr.op === "const" && typeof expr.value === "number") {
    return expr.value;
  }
  return 7.9;
}

function monthlyRentFromIr(ir: ContractIR): number {
  const rentFormula = ir.clauses.find(
    (clause) =>
      clause.effect.kind === "formula" &&
      clause.modeled &&
      clause.effect.outputVar === "monthly_rent_due" &&
      clause.effect.expr.op === "const" &&
      typeof clause.effect.expr.value === "number",
  );
  if (!rentFormula || rentFormula.effect.kind !== "formula") return 75000;
  return rentFormula.effect.expr.value ?? 75000;
}

function irContextAssumptions(ir: ContractIR, archetype: Archetype): string[] {
  return [
    `Scenario generated for contract ${ir.contractId}`,
    `Archetype: ${archetype.label} (${archetype.id})`,
    `Modeled coverage in IR: ${ir.metadata.modeledClauseCount}/${ir.metadata.clauseCount}`,
  ];
}

function creditCardFallback(ir: ContractIR, archetype: Archetype): Scenario {
  const apr = aprFromIr(ir);
  const context = irContextAssumptions(ir, archetype);
  const baseState: Record<string, string | number | boolean> = {
    contractFamily: "credit_card",
    apr,
    irClauseCount: ir.metadata.clauseCount,
    irModeledClauseCount: ir.metadata.modeledClauseCount,
    statementDate: "2026-01-31",
    dueDate: "2026-02-25",
  };

  if (archetype.id === "on-time") {
    return {
      scenarioId: "scenario.credit-card.on-time",
      assumptions: [
        ...context,
        "Full payment posted before due date",
        "No late fee or over-limit fee should apply",
      ],
      initialState: { ...baseState, balance: 0, creditLimit: 1500 },
      events: [
        { id: "evt-001", date: "2026-01-05", type: "purchase", amount: 300 },
        { id: "evt-002", date: "2026-01-31", type: "statement_close" },
        { id: "evt-003", date: "2026-02-20", type: "payment", amount: 300 },
        { id: "evt-004", date: "2026-02-26", type: "due_check" },
        {
          id: "evt-005",
          date: "2026-02-26",
          type: "notice",
          metadata: { type: "account-review", archetype: archetype.id },
        },
      ],
    };
  }

  if (archetype.id === "over-limit") {
    return {
      scenarioId: "scenario.credit-card.over-limit",
      assumptions: [
        ...context,
        "Opening activity is set to exceed the credit limit at statement close",
        "Over-limit fee is expected to fire",
      ],
      initialState: { ...baseState, balance: 0, creditLimit: 1000 },
      events: [
        { id: "evt-001", date: "2026-01-05", type: "purchase", amount: 1080 },
        { id: "evt-002", date: "2026-01-31", type: "statement_close" },
        { id: "evt-003", date: "2026-02-20", type: "payment", amount: 50 },
        { id: "evt-004", date: "2026-02-26", type: "due_check" },
        {
          id: "evt-005",
          date: "2026-02-26",
          type: "notice",
          metadata: { type: "over-limit-review", archetype: archetype.id },
        },
      ],
    };
  }

  return {
    scenarioId: "scenario.credit-card.late-payment",
    assumptions: [
      ...context,
      "Payment is intentionally below the likely minimum due",
      "Payment is posted after the statement due date",
      "Late fee path is expected to fire",
    ],
    initialState: { ...baseState, balance: 0, creditLimit: 1500 },
    events: [
      { id: "evt-001", date: "2026-01-05", type: "purchase", amount: 300 },
      { id: "evt-002", date: "2026-01-31", type: "statement_close" },
      { id: "evt-003", date: "2026-02-27", type: "payment", amount: 20 },
      { id: "evt-004", date: "2026-02-26", type: "due_check" },
      {
        id: "evt-005",
        date: "2026-02-26",
        type: "notice",
        metadata: { type: "late-payment-review", archetype: archetype.id },
      },
    ],
  };
}

function leaseFallback(ir: ContractIR, archetype: Archetype): Scenario {
  const monthlyRent = monthlyRentFromIr(ir);
  const context = irContextAssumptions(ir, archetype);
  const baseState: Record<string, string | number | boolean> = {
    contractFamily: "lease",
    monthlyRent,
    rentDueDate: "2026-02-01",
    rent_cycle_active: 1,
    irClauseCount: ir.metadata.clauseCount,
    irModeledClauseCount: ir.metadata.modeledClauseCount,
  };

  if (archetype.id === "on-time") {
    return {
      scenarioId: "scenario.lease.on-time",
      assumptions: [
        ...context,
        "Tenant pays full monthly rent on the due date",
        "No default review should fire",
      ],
      initialState: baseState,
      events: [
        {
          id: "evt-001",
          date: "2026-02-01",
          type: "notice",
          metadata: { type: "rent-invoice", archetype: archetype.id },
        },
        { id: "evt-002", date: "2026-02-01", type: "payment", amount: monthlyRent },
        { id: "evt-003", date: "2026-02-10", type: "due_check" },
      ],
    };
  }

  const partialPayment = Number((monthlyRent * 0.6).toFixed(2));
  return {
    scenarioId: "scenario.lease.partial-payment",
    assumptions: [
      ...context,
      "Rent invoice issued at cycle start",
      "Payment is intentionally partial to exercise lease nonpayment behavior",
    ],
    initialState: baseState,
    events: [
      {
        id: "evt-001",
        date: "2026-02-01",
        type: "notice",
        metadata: { type: "rent-invoice", archetype: archetype.id },
      },
      { id: "evt-002", date: "2026-02-05", type: "payment", amount: partialPayment },
      { id: "evt-003", date: "2026-02-10", type: "due_check" },
      {
        id: "evt-004",
        date: "2026-02-10",
        type: "notice",
        metadata: { type: "lease-default-review", archetype: archetype.id },
      },
    ],
  };
}

function genericFallback(ir: ContractIR, archetype: Archetype): Scenario {
  return {
    scenarioId: "scenario.generic.baseline",
    assumptions: [
      ...irContextAssumptions(ir, archetype),
      "Fallback generic scenario because no supported execution family was detected",
      "Events limited to a notice record until more executor semantics are implemented",
    ],
    initialState: {
      contractFamily: "generic",
      irClauseCount: ir.metadata.clauseCount,
      irModeledClauseCount: ir.metadata.modeledClauseCount,
      referenceDate: "2026-01-31",
    },
    events: [
      {
        id: "evt-001",
        date: "2026-01-31",
        type: "notice",
        metadata: { type: "generic-contract-review", archetype: archetype.id },
      },
    ],
  };
}

function fallbackScenario(ir: ContractIR, archetype: Archetype): Scenario {
  const family = contractFamily(ir);
  if (family === "credit_card") return creditCardFallback(ir, archetype);
  if (family === "lease") return leaseFallback(ir, archetype);
  return genericFallback(ir, archetype);
}

function tagScenario(
  scenario: Scenario,
  archetype: Archetype,
  mode: GenerationMode,
  llmRequested: boolean,
  validationNote?: string,
): Scenario {
  const llmUsed = mode === "llm";
  return {
    ...scenario,
    archetype: archetype.id,
    label: archetype.label,
    metadata: {
      generation: {
        llmRequested,
        llmUsed,
        mode,
        archetype: archetype.id,
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

export async function generateScenario(
  options: GenerateScenarioOptions,
): Promise<Scenario> {
  const { ir, archetype, useLlm } = options;

  if (!useLlm) {
    const fallback = fallbackScenario(ir, archetype);
    const failure = checkScenario(fallback, archetype, ir);
    return tagScenario(
      fallback,
      archetype,
      "deterministic_fallback",
      false,
      failure ? `deterministic fallback failed AND-form check: ${failure}` : undefined,
    );
  }

  const systemPrompt =
    "Generate one concrete execution scenario for this contract IR. Return strict JSON only. The scenario must be human-inspectable, include explicit assumptions, keep initialState generic rather than contract-family-hardcoded where possible, and choose events that match the modeled clauses and the requested archetype intent.";

  const userPrompt = [
    `Archetype: ${archetype.label} (${archetype.id})`,
    `Intent: ${archetype.intent}`,
    ``,
    `IR JSON:`,
    JSON.stringify(ir),
  ].join("\n");

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
      `Scenario generation failed for archetype ${archetype.id} in --use-llm mode: ${message}`,
    );
  }

  const llmFailure = checkScenario(llmScenario, archetype, ir);
  if (!llmFailure) {
    return tagScenario(llmScenario, archetype, "llm", true);
  }

  const fallback = fallbackScenario(ir, archetype);
  const fallbackFailure = checkScenario(fallback, archetype, ir);
  const note = fallbackFailure
    ? `LLM rejected: ${llmFailure}; fallback also failed: ${fallbackFailure}`
    : `LLM rejected: ${llmFailure}`;
  return tagScenario(fallback, archetype, "llm_validated_fallback", true, note);
}

export async function generateAllScenarios(
  options: GenerateAllScenariosOptions,
): Promise<{ family: ContractFamily; scenarios: Scenario[] }> {
  const family = contractFamily(options.ir);
  const archetypes = archetypesFor(family);
  const scenarios: Scenario[] = [];
  for (const archetype of archetypes) {
    scenarios.push(
      await generateScenario({ ir: options.ir, archetype, useLlm: options.useLlm }),
    );
  }
  return { family, scenarios };
}
