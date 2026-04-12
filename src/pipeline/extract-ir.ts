import { createHash } from "node:crypto";
import { z } from "zod";
import { callOpenAIJson } from "../llm/openai-json.js";
import type {
  BoolExpr,
  Clause,
  ContractIR,
  Definition,
  Expr,
  SourceSpan,
  TemporalRule,
} from "../types/ir.js";

export interface ExtractIrOptions {
  contractText: string;
  sourceFile: string;
  useLlm: boolean;
}

const extractorVersion = "contract-ir-v1";
type ContractMetadata = ContractIR["metadata"];
type ExtractionMode = ContractMetadata["extraction"]["mode"];

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

function findOptionalSnippet(text: string, pattern: RegExp): string | undefined {
  const match = text.match(pattern);
  if (!match || match.index == null) return undefined;
  return findSnippet(text, pattern, "");
}

function findSnippetFromLabel(text: string, pattern: RegExp): string | undefined {
  const match = text.match(pattern);
  if (!match || match.index == null) return undefined;

  const start = match.index;
  const end = Math.min(text.length, start + 280);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function findAllSnippetsFromLabel(text: string, pattern: RegExp): string[] {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  const snippets: string[] = [];
  for (const match of text.matchAll(globalPattern)) {
    if (match.index == null) continue;
    const start = match.index;
    const end = Math.min(text.length, start + 280);
    snippets.push(text.slice(start, end).replace(/\s+/g, " ").trim());
  }
  return snippets;
}

interface NormalizedSourceIndex {
  normalized: string;
  rawByNormalized: number[];
}

function buildNormalizedSourceIndex(text: string): NormalizedSourceIndex {
  const normalizedChars: string[] = [];
  const rawByNormalized: number[] = [];
  let lastWasSpace = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char == null) continue;
    if (/\s/.test(char)) {
      if (!lastWasSpace && normalizedChars.length > 0) {
        normalizedChars.push(" ");
        rawByNormalized.push(i);
      }
      lastWasSpace = true;
      continue;
    }

    normalizedChars.push(char);
    rawByNormalized.push(i);
    lastWasSpace = false;
  }

  if (normalizedChars[normalizedChars.length - 1] === " ") {
    normalizedChars.pop();
    rawByNormalized.pop();
  }

  return {
    normalized: normalizedChars.join(""),
    rawByNormalized,
  };
}

function normalizeSourceSnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function attachSourceSpans(contractText: string, clauses: Clause[]): Clause[] {
  const index = buildNormalizedSourceIndex(contractText);
  let searchFrom = 0;

  return clauses.map((clause) => {
    if (clause.sourceSpan) return clause;

    const snippet = normalizeSourceSnippet(clause.sourceText);
    if (!snippet) return clause;

    let normalizedStart = index.normalized.indexOf(snippet, searchFrom);
    if (normalizedStart < 0) {
      normalizedStart = index.normalized.indexOf(snippet);
    }
    if (normalizedStart < 0) return clause;

    const normalizedEnd = normalizedStart + snippet.length - 1;
    const rawStart = index.rawByNormalized[normalizedStart];
    const rawEnd = index.rawByNormalized[normalizedEnd];
    if (rawStart == null || rawEnd == null) return clause;

    searchFrom = normalizedStart + snippet.length;
    return {
      ...clause,
      sourceSpan: {
        start: rawStart,
        end: rawEnd + 1,
      },
    };
  });
}

function cleanHeading(value: string): string {
  return value.replace(/\*\*/g, "").replace(/\s+/g, " ").trim().replace(/[.:]+$/, "");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function titleFromText(text: string, sourceFile: string): string {
  const headingMatch = text.match(/^#\s+(.+)$/m);
  if (headingMatch?.[1]) return cleanHeading(headingMatch[1]);

  return sourceFile.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
}

function contractIdFrom(title: string, sourceFile: string): string {
  const titleSlug = slugify(title);
  if (titleSlug) return titleSlug;

  return slugify(sourceFile.replace(/\.[^.]+$/, "")) || "contract";
}

function normalizeContractText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
}

function extractionHashFor(text: string, sourceFile: string): string {
  return createHash("sha256")
    .update(`${extractorVersion}\n${sourceFile}\n${normalizeContractText(text)}`)
    .digest("hex");
}

function buildMetadata(
  text: string,
  sourceFile: string,
  clauses: Clause[],
  extractionMode: ExtractionMode,
): ContractMetadata {
  const llmUsed = extractionMode === "llm";
  return {
    sourceFile,
    extractionHash: extractionHashFor(text, sourceFile),
    extractorVersion,
    clauseCount: clauses.length,
    modeledClauseCount: clauses.filter((clause) => clause.modeled).length,
    extraction: {
      llmRequested: llmUsed,
      llmUsed,
      mode: extractionMode,
    },
  };
}

function extractJurisdiction(text: string): string | undefined {
  const match = text.match(/laws of the State of\s+([A-Za-z ]+?)(?:\s+and federal law|[.])/i);
  return match?.[1]?.trim();
}

function extractIssuerName(text: string): string | undefined {
  const match =
    text.match(/“Credit Union” mean\s+([^.\n]+?)\s+or its successors/i) ||
    text.match(/write to us at:\s+([^,\n]+(?:Credit Union|Bank|Financial))/i);
  return match?.[1]?.trim();
}

function extractQuotedDefinition(
  text: string,
  id: string,
  term: string,
  meaningPattern: RegExp,
): Definition | undefined {
  const sourceText = findOptionalSnippet(text, meaningPattern);
  const meaningMatch = text.match(meaningPattern);
  const meaning = meaningMatch?.[1]?.replace(/\s+/g, " ").trim();
  if (!sourceText || !meaning) return undefined;

  return {
    id,
    term,
    meaning,
    sourceText,
  };
}

function extractDefinitions(text: string): Definition[] {
  const definitions: Definition[] = [];

  const newBalance = extractQuotedDefinition(
    text,
    "def.new_balance",
    "New Balance",
    /“new balance”[^.]*?which is\s+(.+?)\./i,
  );
  if (newBalance) definitions.push(newBalance);

  const paymentDueDate = extractQuotedDefinition(
    text,
    "def.payment_due_date",
    "Payment due date",
    /“payment due date”[^.]*?(shown on the periodic statement[^.]*?due)/i,
  );
  if (paymentDueDate) definitions.push(paymentDueDate);

  return definitions;
}

function extractFixedFee(text: string, label: RegExp): number | undefined {
  for (const snippet of findAllSnippetsFromLabel(text, label)) {
    const match = snippet.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
    if (!match?.[1] || match.index == null) continue;
    const none = snippet.match(/\bnone\b/i);
    if (none && none.index != null && none.index < match.index) continue;
    return Number.parseFloat(match[1]);
  }
  return undefined;
}

function extractPercentFee(text: string, label: RegExp): number | undefined {
  for (const snippet of findAllSnippetsFromLabel(text, label)) {
    const match = snippet.match(/([0-9]+(?:\.[0-9]+)?)\s*%/);
    if (!match?.[1] || match.index == null) continue;
    const none = snippet.match(/\bnone\b/i);
    if (none && none.index != null && none.index < match.index) continue;
    return Number.parseFloat(match[1]);
  }
  return undefined;
}

function parseMoney(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const normalized = raw.replace(/,/g, "");
  const amount = Number.parseFloat(normalized);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  return amount;
}

function extractLeaseMonthlyRent(text: string): { amount?: number; sourceText?: string } {
  const monthlyRentMatch =
    text.match(/Monthly\s+Rent[\s\S]{0,220}?\$\s*([0-9][0-9,]*(?:\.[0-9]{2})?)/i) ||
    text.match(/monthly rental installments[\s\S]{0,220}?\$\s*([0-9][0-9,]*(?:\.[0-9]{2})?)/i);
  if (!monthlyRentMatch) return {};

  const amount = parseMoney(monthlyRentMatch[1]);
  const sourceText = findOptionalSnippet(
    text,
    /Monthly\s+Rent[\s\S]{0,220}?\$\s*[0-9][0-9,]*(?:\.[0-9]{2})?/i,
  );
  return {
    ...(typeof amount === "number" ? { amount } : {}),
    ...(sourceText ? { sourceText } : {}),
  };
}

function extractLeaseParties(text: string): { landlord?: string; tenant?: string } {
  const match = text.match(
    /between\s+(.+?)\s+\(hereinafter\s+called\s+"Landlord"\),?\s+and\s+(.+?)\s+\(hereinafter\s+called\s+"Tenant"\)/is,
  );
  if (!match) return {};

  const landlord = match[1]?.replace(/\s+/g, " ").trim();
  const tenant = match[2]?.replace(/\s+/g, " ").trim();
  return {
    ...(landlord ? { landlord } : {}),
    ...(tenant ? { tenant } : {}),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectGenericHeadings(text: string): string[] {
  const headings: string[] = [];
  const seen = new Set<string>();
  const skip = new Set(["TABLE OF CONTENTS", "WITNESSETH", "PREMISES", "PARAGRAPH", "PAGE"]);

  const pushHeading = (raw: string | undefined): void => {
    const cleaned = cleanHeading(raw || "");
    if (!cleaned || cleaned.length < 4) return;

    const compact = cleaned.replace(/\s+/g, " ");
    const wordCount = compact.split(" ").filter(Boolean).length;
    if (wordCount > 8) return;
    if (/[,:;]/.test(compact)) return;
    const normalized = compact.toUpperCase();
    if (normalized.includes("LEASE AGREEMENT") || normalized.includes("CREDIT CARD AGREEMENT")) {
      return;
    }
    if (normalized.startsWith("EXHIBIT")) return;
    if (skip.has(normalized)) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    headings.push(compact);
  };

  for (const match of text.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    pushHeading(match[1]);
  }

  for (const match of text.matchAll(/^\s*\d{1,3}\.\s+([A-Za-z][A-Za-z0-9 ,'"()&/\-]{3,100}?)\.\s*$/gm)) {
    pushHeading(match[1]);
  }

  for (const match of text.matchAll(/^\s*\d+\s+([A-Z][A-Z /&'()-]{4,})\s+\d+\s*$/gm)) {
    pushHeading(match[1]);
  }

  return headings;
}

function addGenericUnmodeledClauses(text: string, clauses: Clause[]): void {
  if (clauses.some((clause) => clause.modeled)) return;

  const headings = collectGenericHeadings(text);
  for (const title of headings) {
    clauses.push({
      id: `clause.unmodeled.${slugify(title) || clauses.length + 1}`,
      title,
      kind: "obligation",
      actor: "party",
      action: `See source text for unsupported clause: ${title}`,
      due: { type: "on_date", value: "see_source_text" },
      sourceText: findSnippet(text, new RegExp(escapeRegExp(title), "i"), title),
      modeled: false,
    });
    if (clauses.length >= 3) return;
  }

  if (clauses.length === 0) {
    clauses.push({
      id: "clause.unmodeled.summary",
      title: "Unsupported contract terms",
      kind: "obligation",
      actor: "party",
      action: "See source text for unsupported contract obligations",
      due: { type: "on_date", value: "see_source_text" },
      sourceText: normalizeContractText(text).slice(0, 260),
      modeled: false,
    });
  }
}

function heuristicFallbackIr(text: string, sourceFile: string): ContractIR {
  const title = titleFromText(text, sourceFile);
  const contractId = contractIdFrom(title, sourceFile);
  const issuerName = extractIssuerName(text);
  const isCreditCard = /\b(?:credit\s+card|visa|cardholder)\b/i.test(`${title}\n${text}`);
  const isLease =
    !isCreditCard &&
    /\blease\b/i.test(`${title}\n${text}`) &&
    /\b(?:monthly rental|monthly rent|landlord|tenant)\b/i.test(text);
  const jurisdiction = extractJurisdiction(text);
  const clauses: Clause[] = [];

  if (isLease) {
    const leaseRent = extractLeaseMonthlyRent(text);
    if (typeof leaseRent.amount === "number") {
      clauses.push({
        id: "clause.obligation.monthly_rent",
        title: "Monthly rent due",
        kind: "obligation",
        actor: "tenant",
        action: "Pay monthly rent by the first day of each month",
        due: { type: "on_date", value: "first_day_of_month" },
        condition: { op: "eq", left: "rent_cycle_active", right: 1 },
        sourceText: leaseRent.sourceText || "Monthly rent payment terms",
        modeled: true,
      });
      clauses.push({
        id: "clause.formula.monthly_rent",
        title: "Monthly rent amount",
        kind: "formula",
        outputVar: "monthly_rent_due",
        expr: { op: "const", value: leaseRent.amount },
        sourceText: leaseRent.sourceText || "Monthly rent amount",
        modeled: true,
      });
    }

    const leaseDefaultSnippet = findOptionalSnippet(
      text,
      /Default and[\s\S]{0,260}?events of default by Tenant under/i,
    );
    if (leaseDefaultSnippet) {
      clauses.push({
        id: "clause.default.tenant_default",
        title: "Tenant default and remedies",
        kind: "default",
        triggerDescription: "Tenant default and remedies are described in the lease",
        consequences: ["Refer to source text for full remedies and cure mechanics"],
        sourceText: leaseDefaultSnippet,
        modeled: false,
      });
    }
  }

  const minimumPaymentSnippet = findOptionalSnippet(
    text,
    /You agree to pay on or before the “payment due date”[\s\S]{0,500}?minimum payment/i,
  );
  if (minimumPaymentSnippet) {
    clauses.push({
      id: "clause.obligation.minimum_payment",
      title: "Minimum payment due by statement due date",
      kind: "obligation",
      actor: isCreditCard ? "cardholder" : "party",
      action: "Pay at least the minimum payment by due date",
      due: { type: "on_date", value: "statement_due_date" },
      sourceText: minimumPaymentSnippet,
      modeled: true,
    });
  }

  const minimumPaymentFormulaSnippet = findOptionalSnippet(
    text,
    /minimum payment[^.]*?3%\s+of the New Balance or \$15\.00[^.]*?\./i,
  );
  if (minimumPaymentFormulaSnippet) {
    clauses.push({
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
      sourceText: minimumPaymentFormulaSnippet,
      modeled: true,
    });
  }

  const lateFee = extractFixedFee(text, /Late Payment Fee/i);
  if (typeof lateFee === "number") {
    clauses.push({
      id: "clause.fee.late_payment",
      title: "Late payment fee",
      kind: "fee",
      feeType: "late_payment",
      amountType: "fixed",
      amountValue: lateFee,
      triggerDescription: "Payment due is not met by due-check date",
      sourceText: findSnippetFromLabel(text, /Late Payment Fee/i) || "Late payment fee",
      modeled: true,
    });
  }

  const overLimitFee = extractFixedFee(text, /Over(?: Credit Limit|[- ]the-Credit Limit) Fee/i);
  if (typeof overLimitFee === "number") {
    clauses.push({
      id: "clause.fee.over_limit",
      title: "Over-limit fee",
      kind: "fee",
      feeType: "over_limit",
      amountType: "fixed",
      amountValue: overLimitFee,
      triggerDescription: "Statement balance exceeds credit limit",
      sourceText:
        findSnippetFromLabel(text, /Over(?: Credit Limit|[- ]the-Credit Limit) Fee/i) ||
        "Over credit limit fee",
      modeled: true,
    });
  }

  const creditLimitSnippet = findOptionalSnippet(
    text,
    /Credit Limits\.[\s\S]{0,240}?outstanding balance[^.]*?exceed your credit limit/i,
  );
  if (creditLimitSnippet) {
    clauses.push({
      id: "clause.obligation.credit_limit",
      title: "Stay within credit limit",
      kind: "obligation",
      actor: isCreditCard ? "cardholder" : "party",
      action: "Keep the outstanding balance within the credit limit",
      due: { type: "on_date", value: "ongoing" },
      sourceText: creditLimitSnippet,
      modeled: false,
    });
  }

  const returnedPaymentFee = extractFixedFee(text, /Returned Payment Fee/i);
  if (typeof returnedPaymentFee === "number") {
    clauses.push({
      id: "clause.fee.returned_payment",
      title: "Returned payment fee",
      kind: "fee",
      feeType: "returned_payment",
      amountType: "fixed",
      amountValue: returnedPaymentFee,
      triggerDescription: "Payment instrument is returned unpaid",
      sourceText:
        findSnippetFromLabel(text, /Returned Payment Fee/i) || "Returned payment fee",
      modeled: false,
    });
  }

  const foreignTxnFee = extractPercentFee(text, /Foreign Transaction/i);
  if (typeof foreignTxnFee === "number") {
    clauses.push({
      id: "clause.fee.foreign_transaction",
      title: "Foreign transaction fee",
      kind: "fee",
      feeType: "foreign_txn",
      amountType: "percent",
      amountValue: foreignTxnFee,
      triggerDescription: "Foreign currency or cross-border transaction is posted",
      sourceText:
        findSnippetFromLabel(text, /Foreign Transaction/i) || "Foreign transaction fee",
      modeled: false,
    });
  }

  const illegalUseDefaultSnippet = findOptionalSnippet(
    text,
    /illegal use of the Card will be deemed an act of default/i,
  );
  if (illegalUseDefaultSnippet) {
    clauses.push({
      id: "clause.default.illegal_use",
      title: "Default on illegal card use",
      kind: "default",
      triggerDescription: "Illegal use of the card is treated as a default",
      consequences: ["Default may be asserted by the credit union"],
      sourceText: illegalUseDefaultSnippet,
      modeled: false,
    });
  }

  addGenericUnmodeledClauses(text, clauses);
  const clausesWithSpans = attachSourceSpans(text, clauses);

  return {
    contractId,
    title,
    ...(jurisdiction ? { jurisdiction } : {}),
    currency: "USD",
    parties: [
      ...(isLease
        ? (() => {
            const leaseParties = extractLeaseParties(text);
            const parties: ContractIR["parties"] = [];
            parties.push({
              id: "landlord",
              role: "landlord",
              name: leaseParties.landlord || "Landlord",
            });
            parties.push({
              id: "tenant",
              role: "tenant",
              name: leaseParties.tenant || "Tenant",
            });
            return parties;
          })()
        : []),
      ...(issuerName
        ? [
            {
              id: "issuer",
              role: "issuer",
              name: issuerName,
            },
          ]
        : []),
      {
        id: isCreditCard ? "cardholder" : isLease ? "tenant" : "counterparty",
        role: isCreditCard ? "borrower" : isLease ? "tenant" : "counterparty",
        name: isCreditCard ? "Cardholder" : isLease ? "Tenant" : "Counterparty",
      },
    ].filter((party, index, arr) => arr.findIndex((p) => p.id === party.id) === index),
    definitions: extractDefinitions(text),
    clauses: clausesWithSpans,
    metadata: buildMetadata(text, sourceFile, clausesWithSpans, "heuristic_fallback"),
  };
}

function normalizeSourceSpan(raw: unknown): SourceSpan | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = raw as Record<string, unknown>;
  const start = candidate.start;
  const end = candidate.end;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return undefined;
  if ((start as number) < 0 || (end as number) < (start as number)) return undefined;
  return { start: start as number, end: end as number };
}

function normalizeTemporalRule(raw: unknown): TemporalRule {
  if (raw && typeof raw === "object") {
    const candidate = raw as Record<string, unknown>;
    const type = candidate.type;
    const value = candidate.value;
    const isValidType =
      type === "calendar_days" || type === "business_days" || type === "on_date";
    const isValidValue = typeof value === "string" || typeof value === "number";
    if (isValidType && isValidValue) {
      const anchor = candidate.anchor;
      return {
        type,
        value,
        ...(typeof anchor === "string" && anchor ? { anchor } : {}),
      };
    }
  }
  return { type: "on_date", value: "see_source_text" };
}

function normalizeExpr(raw: unknown, depth = 0): Expr {
  if (!raw || typeof raw !== "object" || depth > 4) {
    return { op: "const", value: 0 };
  }
  const candidate = raw as Record<string, unknown>;
  const op = candidate.op;
  if (
    op !== "const" &&
    op !== "var" &&
    op !== "add" &&
    op !== "sub" &&
    op !== "mul" &&
    op !== "div" &&
    op !== "max" &&
    op !== "min"
  ) {
    return { op: "const", value: 0 };
  }

  if (op === "const") {
    const value = candidate.value;
    return {
      op: "const",
      value: typeof value === "number" && Number.isFinite(value) ? value : 0,
    };
  }
  if (op === "var") {
    return {
      op: "var",
      name: typeof candidate.name === "string" && candidate.name ? candidate.name : "var",
    };
  }

  const args = Array.isArray(candidate.args)
    ? candidate.args.map((item) => normalizeExpr(item, depth + 1))
    : [];
  return {
    op,
    args,
  };
}

function normalizeBoolExpr(raw: unknown, depth = 0): BoolExpr | undefined {
  if (!raw || typeof raw !== "object" || depth > 4) return undefined;
  const candidate = raw as Record<string, unknown>;
  const op = candidate.op;
  if (
    op !== "eq" &&
    op !== "neq" &&
    op !== "gt" &&
    op !== "gte" &&
    op !== "lt" &&
    op !== "lte" &&
    op !== "and" &&
    op !== "or"
  ) {
    return undefined;
  }

  if (op === "and" || op === "or") {
    const args = Array.isArray(candidate.args)
      ? candidate.args
          .map((item) => normalizeBoolExpr(item, depth + 1))
          .filter((item): item is BoolExpr => item != null)
      : [];
    if (args.length === 0) return undefined;
    return { op, args };
  }

  const leftRaw = candidate.left;
  const rightRaw = candidate.right;
  const left =
    typeof leftRaw === "string" || typeof leftRaw === "number"
      ? leftRaw
      : normalizeBoolExpr(leftRaw, depth + 1);
  const right =
    typeof rightRaw === "string" || typeof rightRaw === "number"
      ? rightRaw
      : normalizeBoolExpr(rightRaw, depth + 1);

  if (left == null || right == null) return undefined;
  return {
    op,
    left,
    right,
  };
}

function normalizeClause(rawClause: Record<string, unknown>): Clause {
  const kind = rawClause.kind;
  const sourceSpan = normalizeSourceSpan(rawClause.sourceSpan);
  const condition = normalizeBoolExpr(rawClause.condition);
  if (kind === "obligation") {
    return {
      id: String(rawClause.id),
      title: String(rawClause.title),
      kind: "obligation",
      actor: String(rawClause.actor || "party"),
      action: String(rawClause.action || "Perform obligation"),
      due: normalizeTemporalRule(rawClause.due),
      ...(condition ? { condition } : {}),
      ...(rawClause.curePeriod ? { curePeriod: normalizeTemporalRule(rawClause.curePeriod) } : {}),
      sourceText: String(rawClause.sourceText),
      ...(sourceSpan ? { sourceSpan } : {}),
      modeled: Boolean(rawClause.modeled),
    };
  }

  if (kind === "formula") {
    return {
      id: String(rawClause.id),
      title: String(rawClause.title),
      kind: "formula",
      outputVar: String(rawClause.outputVar || "derived_value"),
      expr: normalizeExpr(rawClause.expr),
      sourceText: String(rawClause.sourceText),
      ...(sourceSpan ? { sourceSpan } : {}),
      modeled: Boolean(rawClause.modeled),
    };
  }

  if (kind === "fee") {
    return {
      id: String(rawClause.id),
      title: String(rawClause.title),
      kind: "fee",
      feeType:
        rawClause.feeType === "late_payment" ||
        rawClause.feeType === "over_limit" ||
        rawClause.feeType === "returned_payment" ||
        rawClause.feeType === "foreign_txn"
          ? rawClause.feeType
          : "late_payment",
      amountType: rawClause.amountType === "percent" ? "percent" : "fixed",
      amountValue: Number.isFinite(Number(rawClause.amountValue))
        ? Number(rawClause.amountValue)
        : 0,
      triggerDescription: String(rawClause.triggerDescription || ""),
      sourceText: String(rawClause.sourceText),
      ...(sourceSpan ? { sourceSpan } : {}),
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
    ...(sourceSpan ? { sourceSpan } : {}),
    modeled: Boolean(rawClause.modeled),
  };
}

function normalizeIr(raw: unknown, sourceFile: string, contractText: string): ContractIR {
  const parsed = IrTopSchema.parse(raw);
  const clauses = parsed.clauses.map(normalizeClause);
  const clausesWithSpans = attachSourceSpans(contractText, clauses);

  return {
    contractId: parsed.contractId,
    title: parsed.title,
    currency: "USD",
    parties: parsed.parties,
    definitions: parsed.definitions,
    clauses: clausesWithSpans,
    ...(parsed.jurisdiction ? { jurisdiction: parsed.jurisdiction } : {}),
    metadata: buildMetadata(contractText, sourceFile, clausesWithSpans, "llm"),
  };
}

export async function extractIr(options: ExtractIrOptions): Promise<ContractIR> {
  if (!options.useLlm) {
    return heuristicFallbackIr(options.contractText, options.sourceFile);
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

    return normalizeIr(llmResult, options.sourceFile, options.contractText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`IR extraction failed in --use-llm mode: ${message}`);
  }
}
