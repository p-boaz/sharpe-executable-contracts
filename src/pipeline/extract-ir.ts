import { z } from "zod";
import { callOpenAIJson } from "../llm/openai-json.js";
import type { Clause, ContractIR } from "../types/ir.js";

export interface ExtractIrOptions {
  contractText: string;
  sourceFile: string;
  useLlm: boolean;
}

const extractorVersion = "contract-ir-v1";

const IrTopSchema = z.object({
  contractId: z.string().min(1),
  title: z.string().min(1),
  jurisdiction: z.string().optional(),
  currency: z.literal("USD"),
  parties: z.array(
    z.object({
      id: z.string().min(1),
      role: z.string().min(1),
      name: z.string().min(1),
    }),
  ),
  definitions: z.array(
    z.object({
      id: z.string().min(1),
      term: z.string().min(1),
      meaning: z.string().min(1),
      sourceText: z.string().min(1),
    }),
  ),
  clauses: z.array(
    z
      .object({
        id: z.string().min(1),
        title: z.string().min(1),
        kind: z.enum(["obligation", "formula", "fee", "default"]),
        sourceText: z.string().min(1),
        modeled: z.boolean(),
      })
      .passthrough(),
  ),
});

const irJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "contractId",
    "title",
    "currency",
    "parties",
    "definitions",
    "clauses",
  ],
  properties: {
    contractId: { type: "string" },
    title: { type: "string" },
    jurisdiction: { type: "string" },
    currency: { type: "string", enum: ["USD"] },
    parties: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "role", "name"],
        properties: {
          id: { type: "string" },
          role: { type: "string" },
          name: { type: "string" },
        },
      },
    },
    definitions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "term", "meaning", "sourceText"],
        properties: {
          id: { type: "string" },
          term: { type: "string" },
          meaning: { type: "string" },
          sourceText: { type: "string" },
        },
      },
    },
    clauses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        required: ["id", "title", "kind", "sourceText", "modeled"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          kind: {
            type: "string",
            enum: ["obligation", "formula", "fee", "default"],
          },
          sourceText: { type: "string" },
          modeled: { type: "boolean" },
        },
      },
    },
  },
};

function findSnippet(text: string, pattern: RegExp, fallback: string): string {
  const match = text.match(pattern);
  if (!match || match.index == null) return fallback;
  const start = Math.max(0, match.index - 120);
  const end = Math.min(text.length, match.index + 220);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function extractApr(text: string): number {
  const aprMatches = [
    ...text.matchAll(/ANNUAL PERCENTAGE RATE of\s+([0-9]+(?:\.[0-9]+)?)/gi),
  ];
  if (aprMatches.length > 0) {
    return Number.parseFloat(aprMatches[0]?.[1] || "7.9");
  }

  const fallback = text.match(
    /APR\s+for\s+Purchases[^\n]*?([0-9]+(?:\.[0-9]+)?)/i,
  );
  return Number.parseFloat(fallback?.[1] || "7.9");
}

function extractFee(text: string, label: RegExp, fallback: number): number {
  const snippet = findSnippet(text, label, "");
  const match = snippet.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
  return Number.parseFloat(match?.[1] || `${fallback}`);
}

function heuristicCreditCardIr(text: string, sourceFile: string): ContractIR {
  const apr = extractApr(text);
  const lateFee = extractFee(text, /Late Payment Fee/i, 25);
  const overLimitFee = extractFee(text, /Over Credit Limit Fee/i, 10);

  const clauses: Clause[] = [
    {
      id: "clause.obligation.minimum_payment",
      title: "Minimum payment due by statement due date",
      kind: "obligation",
      actor: "cardholder",
      action: "Pay at least the minimum payment by due date",
      due: { type: "on_date", value: "statement_due_date" },
      sourceText: findSnippet(text, /minimum payment/i, "Minimum payment terms"),
      modeled: true,
    },
    {
      id: "clause.formula.minimum_payment",
      title: "Minimum payment formula",
      kind: "formula",
      outputVar: "minimum_payment_due",
      expr: {
        op: "max",
        args: [
          {
            op: "mul",
            args: [
              { op: "var", name: "new_balance" },
              { op: "const", value: 0.03 },
            ],
          },
          { op: "const", value: 15 },
        ],
      },
      sourceText: findSnippet(
        text,
        /3% of the New Balance or \$15\.00/i,
        "3% of new balance or $15",
      ),
      modeled: true,
    },
    {
      id: "clause.formula.apr",
      title: "APR nominal value",
      kind: "formula",
      outputVar: "apr_nominal",
      expr: { op: "const", value: apr },
      sourceText: findSnippet(text, /ANNUAL PERCENTAGE RATE/i, "APR definitions"),
      modeled: true,
    },
    {
      id: "clause.fee.late_payment",
      title: "Late payment fee",
      kind: "fee",
      feeType: "late_payment",
      amountType: "fixed",
      amountValue: lateFee,
      triggerDescription: "Payment due is not met by due-check date",
      sourceText: findSnippet(text, /Late Payment Fee/i, "Late payment fee"),
      modeled: true,
    },
    {
      id: "clause.fee.over_limit",
      title: "Over-limit fee",
      kind: "fee",
      feeType: "over_limit",
      amountType: "fixed",
      amountValue: overLimitFee,
      triggerDescription: "Statement balance exceeds credit limit",
      sourceText: findSnippet(
        text,
        /Over Credit Limit Fee/i,
        "Over credit limit fee",
      ),
      modeled: true,
    },
    {
      id: "clause.default.nonpayment",
      title: "Default on nonpayment",
      kind: "default",
      triggerDescription: "Failure to make payment on time",
      consequences: ["Account in default", "Acceleration may apply"],
      sourceText: findSnippet(text, /Default\./i, "Default terms"),
      modeled: true,
    },
  ];

  return {
    contractId: "westex-credit-card",
    title: "WesTex Credit Card Agreement",
    jurisdiction: "Texas",
    currency: "USD",
    parties: [
      {
        id: "credit_union",
        role: "issuer",
        name: "WesTex Community Credit Union",
      },
      { id: "cardholder", role: "borrower", name: "Cardholder" },
    ],
    definitions: [
      {
        id: "def.new_balance",
        term: "New Balance",
        meaning: "Previous balance + charges - payments/credits",
        sourceText: findSnippet(text, /new balance/i, "new balance definition"),
      },
      {
        id: "def.payment_due_date",
        term: "Payment due date",
        meaning:
          "Date shown on periodic statement by which minimum or full payment is due",
        sourceText: findSnippet(text, /payment due date/i, "payment due date"),
      },
    ],
    clauses,
    metadata: {
      sourceFile,
      extractedAt: "1970-01-01T00:00:00.000Z",
      extractorVersion,
      clauseCount: clauses.length,
      modeledClauseCount: clauses.filter((c: Clause) => c.modeled).length,
    },
  };
}

function normalizeClause(rawClause: Record<string, unknown>): Clause {
  const kind = rawClause.kind;
  if (kind === "obligation") {
    return {
      id: String(rawClause.id),
      title: String(rawClause.title),
      kind: "obligation",
      actor: String(rawClause.actor || "cardholder"),
      action: String(rawClause.action || "Perform obligation"),
      due: rawClause.due as never,
      condition: rawClause.condition as never,
      curePeriod: rawClause.curePeriod as never,
      sourceText: String(rawClause.sourceText),
      modeled: Boolean(rawClause.modeled),
    };
  }

  if (kind === "formula") {
    return {
      id: String(rawClause.id),
      title: String(rawClause.title),
      kind: "formula",
      outputVar: String(rawClause.outputVar || "derived_value"),
      expr: rawClause.expr as never,
      sourceText: String(rawClause.sourceText),
      modeled: Boolean(rawClause.modeled),
    };
  }

  if (kind === "fee") {
    return {
      id: String(rawClause.id),
      title: String(rawClause.title),
      kind: "fee",
      feeType: rawClause.feeType as never,
      amountType: rawClause.amountType as never,
      amountValue: Number(rawClause.amountValue || 0),
      triggerDescription: String(rawClause.triggerDescription || ""),
      sourceText: String(rawClause.sourceText),
      modeled: Boolean(rawClause.modeled),
    };
  }

  return {
    id: String(rawClause.id),
    title: String(rawClause.title),
    kind: "default",
    triggerDescription: String(rawClause.triggerDescription || ""),
    consequences: Array.isArray(rawClause.consequences)
      ? rawClause.consequences.map((v) => String(v))
      : [],
    sourceText: String(rawClause.sourceText),
    modeled: Boolean(rawClause.modeled),
  };
}

function normalizeIr(raw: unknown, sourceFile: string): ContractIR {
  const parsed = IrTopSchema.parse(raw);
  const clauses = parsed.clauses.map(normalizeClause);

  return {
    contractId: parsed.contractId,
    title: parsed.title,
    currency: "USD",
    parties: parsed.parties,
    definitions: parsed.definitions,
    clauses,
    ...(parsed.jurisdiction ? { jurisdiction: parsed.jurisdiction } : {}),
    metadata: {
      sourceFile,
      extractedAt: "1970-01-01T00:00:00.000Z",
      extractorVersion,
      clauseCount: clauses.length,
      modeledClauseCount: clauses.filter((c) => c.modeled).length,
    },
  };
}

export async function extractIr(options: ExtractIrOptions): Promise<ContractIR> {
  if (!options.useLlm) {
    return heuristicCreditCardIr(options.contractText, options.sourceFile);
  }

  const systemPrompt =
    "Extract a compact executable contract IR from markdown text. Keep only clauses that can be executed deterministically. Output strict JSON.";

  const userPrompt = `Source file: ${options.sourceFile}\n\nContract markdown:\n${options.contractText}`;

  try {
    const llmResult = await callOpenAIJson<unknown>({
      systemPrompt,
      userPrompt,
      schema: irJsonSchema,
    });

    return normalizeIr(llmResult, options.sourceFile);
  } catch {
    return heuristicCreditCardIr(options.contractText, options.sourceFile);
  }
}
