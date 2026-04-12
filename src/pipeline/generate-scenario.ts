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
  initialState: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
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

function hasModeledClause(
  ir: ContractIR,
  matcher: (clause: ContractIR["clauses"][number]) => boolean,
): boolean {
  return ir.clauses.some((clause) => clause.modeled && matcher(clause));
}

function monthlyRentFromIr(ir: ContractIR): number {
  const rentFormula = ir.clauses.find(
    (
      clause,
    ): clause is Extract<ContractIR["clauses"][number], { kind: "formula" }> =>
      clause.kind === "formula" &&
      clause.modeled &&
      clause.outputVar === "monthly_rent_due" &&
      clause.expr.op === "const" &&
      typeof clause.expr.value === "number",
  );
  if (!rentFormula) return 0;
  return rentFormula.expr.value || 0;
}

function contractFamily(ir: ContractIR): "credit_card" | "lease" | "generic" {
  const title = `${ir.title} ${ir.contractId}`.toLowerCase();
  const hasCreditSignals =
    title.includes("credit") ||
    title.includes("card") ||
    hasModeledClause(
      ir,
      (clause) =>
        clause.kind === "fee" &&
        (clause.feeType === "late_payment" || clause.feeType === "over_limit"),
    ) ||
    hasModeledClause(
      ir,
      (clause) =>
        clause.kind === "formula" && clause.outputVar === "minimum_payment_due",
    );
  const hasLeaseSignals =
    title.includes("lease") ||
    hasModeledClause(
      ir,
      (clause) =>
        clause.kind === "obligation" && clause.id === "clause.obligation.monthly_rent",
    ) ||
    hasModeledClause(
      ir,
      (clause) => clause.kind === "formula" && clause.outputVar === "monthly_rent_due",
    );

  if (hasCreditSignals) return "credit_card";
  if (hasLeaseSignals) return "lease";
  return "generic";
}

function irContextAssumptions(ir: ContractIR): string[] {
  return [
    `Scenario generated for contract ${ir.contractId}`,
    `Modeled coverage in IR: ${ir.metadata.modeledClauseCount}/${ir.metadata.clauseCount}`,
  ];
}

function fallbackScenario(ir: ContractIR): Scenario {
  const family = contractFamily(ir);
  const contextAssumptions = irContextAssumptions(ir);
  const hasMinimumPayment = hasModeledClause(
    ir,
    (clause) => clause.kind === "obligation" && clause.id === "clause.obligation.minimum_payment",
  );
  const hasOverLimitFee = hasModeledClause(
    ir,
    (clause) => clause.kind === "fee" && clause.feeType === "over_limit",
  );
  const hasLateFee = hasModeledClause(
    ir,
    (clause) => clause.kind === "fee" && clause.feeType === "late_payment",
  );

  if (family === "credit_card") {
    const openingBalance = hasOverLimitFee ? 1080 : 300;
    const creditLimit = hasOverLimitFee ? 1000 : 1500;
    const paymentAmount = hasMinimumPayment && hasLateFee ? 20 : 180;

    return {
      scenarioId: "scenario.credit-card.ir-responsive",
      assumptions: [
        ...contextAssumptions,
        "Single billing cycle modeled",
        "Scenario chosen from extracted modeled clauses",
        hasOverLimitFee
          ? "Opening activity is set to exceed the credit limit at statement close"
          : "Opening activity stays within the credit limit",
        hasLateFee
          ? "Payment is intentionally below the likely minimum due"
          : "Payment is intended to satisfy the observed obligation path",
      ],
      initialState: {
        contractFamily: "credit_card",
        balance: 0,
        creditLimit,
        apr: aprFromIr(ir),
        irClauseCount: ir.metadata.clauseCount,
        irModeledClauseCount: ir.metadata.modeledClauseCount,
        statementDate: "2026-01-31",
        dueDate: "2026-02-25",
      },
      events: [
        { id: "evt-001", date: "2026-01-05", type: "purchase", amount: openingBalance },
        { id: "evt-002", date: "2026-01-31", type: "statement_close" },
        { id: "evt-003", date: "2026-02-20", type: "payment", amount: paymentAmount },
        { id: "evt-004", date: "2026-02-26", type: "due_check" },
        {
          id: "evt-005",
          date: "2026-02-26",
          type: "notice",
          metadata: {
            type: hasLateFee ? "late-payment-review" : "account-review",
            family,
          },
        },
      ],
    };
  }

  if (family === "lease") {
    const monthlyRent = monthlyRentFromIr(ir) || 75000;
    const partialPayment = Number((monthlyRent * 0.6).toFixed(2));

    return {
      scenarioId: "scenario.lease.monthly-rent-due-check",
      assumptions: [
        ...contextAssumptions,
        "Single lease rent cycle modeled",
        "Rent invoice is represented as a notice event at cycle start",
        "Payment is intentionally partial to exercise lease nonpayment behavior",
      ],
      initialState: {
        contractFamily: "lease",
        monthlyRent,
        rentDueDate: "2026-02-01",
        rent_cycle_active: 1,
        irClauseCount: ir.metadata.clauseCount,
        irModeledClauseCount: ir.metadata.modeledClauseCount,
      },
      events: [
        {
          id: "evt-001",
          date: "2026-02-01",
          type: "notice",
          metadata: { type: "rent-invoice", family },
        },
        { id: "evt-002", date: "2026-02-05", type: "payment", amount: partialPayment },
        { id: "evt-003", date: "2026-02-10", type: "due_check" },
        {
          id: "evt-004",
          date: "2026-02-10",
          type: "notice",
          metadata: { type: "lease-default-review", family },
        },
      ],
    };
  }

  return {
    scenarioId: "scenario.generic.notice-only",
    assumptions: [
      ...contextAssumptions,
      "Fallback generic scenario because no supported credit-card execution path was detected",
      "Events are limited to notice records until more executor semantics are implemented",
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
        metadata: { type: "generic-contract-review", family },
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
    "Generate one concrete execution scenario for this contract IR. Return strict JSON only. The scenario must be human-inspectable, include explicit assumptions, keep initialState generic rather than contract-family-hardcoded where possible, and choose events that match the modeled clauses.";

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
