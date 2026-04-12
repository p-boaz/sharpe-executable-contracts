import { z } from "zod";
import { callOpenAIJson } from "../llm/openai-json.js";
import type { ContractIR } from "../types/ir.js";
import type { Scenario } from "../types/scenario.js";

export interface GenerateScenarioOptions {
  ir: ContractIR;
  useLlm: boolean;
}

const ScenarioSchema = z.object({
  scenarioId: z.string().min(1),
  assumptions: z.array(z.string()),
  initialState: z.object({
    balance: z.number().finite(),
    creditLimit: z.number().positive(),
    apr: z.number().positive(),
    statementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
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
      metadata: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional(),
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
      additionalProperties: false,
      required: ["balance", "creditLimit", "apr", "statementDate", "dueDate"],
      properties: {
        balance: { type: "number" },
        creditLimit: { type: "number" },
        apr: { type: "number" },
        statementDate: { type: "string" },
        dueDate: { type: "string" },
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
            additionalProperties: {
              anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
            },
          },
        },
      },
    },
  },
};

function aprFromIr(ir: ContractIR): number {
  const formulaClauses = ir.clauses.filter(
    (
      c,
    ): c is Extract<ContractIR["clauses"][number], { kind: "formula" }> =>
      c.kind === "formula",
  );
  const aprClause = formulaClauses.find((c) => c.outputVar === "apr_nominal");
  if (!aprClause) return 7.9;

  if (aprClause.expr.op === "const" && typeof aprClause.expr.value === "number") {
    return aprClause.expr.value;
  }

  return 7.9;
}

function fallbackScenario(ir: ContractIR): Scenario {
  return {
    scenarioId: "scenario.credit-card.late-payment",
    assumptions: [
      "Single billing cycle modeled",
      "No returned payment fee event",
      "Credit line fixed for scenario",
    ],
    initialState: {
      balance: 0,
      creditLimit: 1000,
      apr: aprFromIr(ir),
      statementDate: "2026-01-31",
      dueDate: "2026-02-25",
    },
    events: [
      { id: "evt-001", date: "2026-01-03", type: "purchase", amount: 1200 },
      { id: "evt-002", date: "2026-01-10", type: "cash_advance", amount: 200 },
      { id: "evt-003", date: "2026-01-31", type: "statement_close" },
      { id: "evt-004", date: "2026-02-12", type: "payment", amount: 100 },
      { id: "evt-005", date: "2026-02-26", type: "due_check" },
      { id: "evt-006", date: "2026-02-28", type: "payment", amount: 300 },
      {
        id: "evt-007",
        date: "2026-02-28",
        type: "notice",
        metadata: { type: "customer_call" },
      },
    ],
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

        if (typeof event.amount === "number") {
          base.amount = event.amount;
        }
        if (event.metadata) {
          base.metadata = event.metadata;
        }

        return base;
      })
      .sort((a, b) => {
        const dateCompare = a.date.localeCompare(b.date);
        if (dateCompare !== 0) return dateCompare;
        return a.id.localeCompare(b.id);
      }),
  };
}

export async function generateScenario(
  options: GenerateScenarioOptions,
): Promise<Scenario> {
  if (!options.useLlm) {
    return fallbackScenario(options.ir);
  }

  const systemPrompt =
    "Generate one concrete execution scenario for this contract IR. Return strict JSON only. Include realistic dates/events and amounts so execution can run.";

  const userPrompt = `IR JSON:\n${JSON.stringify(options.ir)}`;

  try {
    const llmResult = await callOpenAIJson<unknown>({
      systemPrompt,
      userPrompt,
      schema: scenarioJsonSchema,
    });

    return normalizeScenario(llmResult);
  } catch {
    return fallbackScenario(options.ir);
  }
}
