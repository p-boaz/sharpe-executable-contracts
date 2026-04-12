import { createHash } from "node:crypto";
import { z } from "zod";
import { callOpenAIJson } from "../llm/openai-json.js";
import type {
  AccumulationUnit,
  BoolExpr,
  Clause,
  ContractIR,
  Definition,
  Effect,
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
  currency: z.string().min(1),
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
        sourceText: z.string().min(1),
        modeled: z.boolean(),
        // Default "untagged" if the LLM omits the tag — normalizer still
        // coerces, so this guards against a hard crash on malformed LLM output
        // and lets the pipeline surface the missing tag rather than 500 out.
        semanticTag: z.string().min(1).optional().default("untagged"),
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
    currency: { type: "string" },
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
        required: ["id", "title", "sourceText", "modeled", "effect"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          sourceText: { type: "string" },
          modeled: { type: "boolean" },
          semanticTag: { type: "string" },
          // `effect` and `condition` are passed through; the normalizer validates them.
          effect: { type: "object" },
          condition: { type: "object" },
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
      sourceText: findSnippet(text, new RegExp(escapeRegExp(title), "i"), title),
      modeled: false,
      semanticTag: "unmodeled_section",
      effect: { kind: "unmodeled" },
    });
    if (clauses.length >= 3) return;
  }

  if (clauses.length === 0) {
    clauses.push({
      id: "clause.unmodeled.summary",
      title: "Unsupported contract terms",
      sourceText: normalizeContractText(text).slice(0, 260),
      modeled: false,
      semanticTag: "unmodeled_summary",
      effect: { kind: "unmodeled" },
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
        sourceText: leaseRent.sourceText || "Monthly rent payment terms",
        modeled: true,
        semanticTag: "rent_obligation",
        condition: { op: "eq", left: "rent_cycle_active", right: 1 },
        effect: {
          kind: "obligation",
          actor: "tenant",
          action: "Pay monthly rent by the first day of each month",
          due: { type: "on_date", value: "first_day_of_month" },
        },
      });
      clauses.push({
        id: "clause.formula.monthly_rent",
        title: "Monthly rent amount",
        sourceText: leaseRent.sourceText || "Monthly rent amount",
        modeled: true,
        semanticTag: "base_rent",
        effect: {
          kind: "formula",
          outputVar: "monthly_rent_due",
          expr: { op: "const", value: leaseRent.amount },
        },
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
        sourceText: leaseDefaultSnippet,
        modeled: false,
        semanticTag: "tenant_default",
        effect: {
          kind: "default",
          consequences: ["Refer to source text for full remedies and cure mechanics"],
        },
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
      sourceText: minimumPaymentSnippet,
      modeled: true,
      semanticTag: "minimum_payment_obligation",
      effect: {
        kind: "obligation",
        actor: isCreditCard ? "cardholder" : "party",
        action: "Pay at least the minimum payment by due date",
        due: { type: "on_date", value: "statement_due_date" },
      },
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
      sourceText: minimumPaymentFormulaSnippet,
      modeled: true,
      semanticTag: "minimum_payment_formula",
      effect: {
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
      },
    });
  }

  const lateFee = extractFixedFee(text, /Late Payment Fee/i);
  if (typeof lateFee === "number") {
    clauses.push({
      id: "clause.fee.late_payment",
      title: "Late payment fee",
      sourceText: findSnippetFromLabel(text, /Late Payment Fee/i) || "Late payment fee",
      modeled: true,
      semanticTag: "late_payment_fee",
      effect: {
        kind: "payment",
        payer: isCreditCard ? "cardholder" : "party",
        payee: "issuer",
        amount: { op: "const", value: lateFee },
      },
    });
  }

  const overLimitFee = extractFixedFee(text, /Over(?: Credit Limit|[- ]the-Credit Limit) Fee/i);
  if (typeof overLimitFee === "number") {
    clauses.push({
      id: "clause.fee.over_limit",
      title: "Over-limit fee",
      sourceText:
        findSnippetFromLabel(text, /Over(?: Credit Limit|[- ]the-Credit Limit) Fee/i) ||
        "Over credit limit fee",
      modeled: true,
      semanticTag: "over_limit_fee",
      effect: {
        kind: "payment",
        payer: isCreditCard ? "cardholder" : "party",
        payee: "issuer",
        amount: { op: "const", value: overLimitFee },
      },
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
      sourceText: creditLimitSnippet,
      modeled: false,
      semanticTag: "credit_limit_obligation",
      effect: {
        kind: "obligation",
        actor: isCreditCard ? "cardholder" : "party",
        action: "Keep the outstanding balance within the credit limit",
        due: { type: "on_date", value: "ongoing" },
      },
    });
  }

  const returnedPaymentFee = extractFixedFee(text, /Returned Payment Fee/i);
  if (typeof returnedPaymentFee === "number") {
    clauses.push({
      id: "clause.fee.returned_payment",
      title: "Returned payment fee",
      sourceText:
        findSnippetFromLabel(text, /Returned Payment Fee/i) || "Returned payment fee",
      modeled: false,
      semanticTag: "returned_payment_fee",
      effect: {
        kind: "payment",
        payer: isCreditCard ? "cardholder" : "party",
        payee: "issuer",
        amount: { op: "const", value: returnedPaymentFee },
      },
    });
  }

  const foreignTxnFee = extractPercentFee(text, /Foreign Transaction/i);
  if (typeof foreignTxnFee === "number") {
    // Percent fee on a transaction amount: amount = (rate / 100) * transaction_amount.
    const rateAsFraction = foreignTxnFee / 100;
    clauses.push({
      id: "clause.fee.foreign_transaction",
      title: "Foreign transaction fee",
      sourceText:
        findSnippetFromLabel(text, /Foreign Transaction/i) || "Foreign transaction fee",
      modeled: false,
      semanticTag: "foreign_transaction_fee",
      effect: {
        kind: "payment",
        payer: isCreditCard ? "cardholder" : "party",
        payee: "issuer",
        amount: {
          op: "mul",
          args: [
            { op: "const", value: rateAsFraction },
            { op: "var", name: "transaction_amount" },
          ],
        },
      },
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
      sourceText: illegalUseDefaultSnippet,
      modeled: false,
      semanticTag: "illegal_use_default",
      effect: {
        kind: "default",
        consequences: ["Default may be asserted by the credit union"],
      },
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

function normalizeTemporalRule(raw: unknown, depth = 0): TemporalRule {
  if (raw && typeof raw === "object" && depth < 3) {
    const candidate = raw as Record<string, unknown>;
    const type = candidate.type;
    const value = candidate.value;
    const isValidType =
      type === "calendar_days" ||
      type === "business_days" ||
      type === "months" ||
      type === "years" ||
      type === "on_date";
    const isValidValue = typeof value === "string" || typeof value === "number";
    if (isValidType && isValidValue) {
      const anchor = candidate.anchor;
      const directionRaw = candidate.direction;
      const direction: TemporalRule["direction"] | undefined =
        directionRaw === "before" || directionRaw === "after" ? directionRaw : undefined;
      const graceAfter =
        candidate.graceAfter && typeof candidate.graceAfter === "object"
          ? normalizeTemporalRule(candidate.graceAfter, depth + 1)
          : undefined;
      return {
        type,
        value,
        ...(typeof anchor === "string" && anchor ? { anchor } : {}),
        ...(direction ? { direction } : {}),
        ...(graceAfter ? { graceAfter } : {}),
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

function normalizeBoolOperand(
  raw: unknown,
  depth: number,
): string | number | boolean | BoolExpr | undefined {
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    return raw;
  }
  return normalizeBoolExpr(raw, depth + 1);
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
    op !== "or" &&
    op !== "not"
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

  if (op === "not") {
    const args = Array.isArray(candidate.args)
      ? candidate.args
          .map((item) => normalizeBoolExpr(item, depth + 1))
          .filter((item): item is BoolExpr => item != null)
      : [];
    if (args.length !== 1) return undefined;
    return { op, args };
  }

  const left = normalizeBoolOperand(candidate.left, depth);
  const right = normalizeBoolOperand(candidate.right, depth);

  if (left == null || right == null) return undefined;
  return {
    op,
    left,
    right,
  };
}

const ACCUMULATION_UNITS: AccumulationUnit[] = [
  "day",
  "month",
  "year",
  "kg",
  "watt",
  "usd_raised",
  "unit",
];

function normalizeEffect(rawClause: Record<string, unknown>): Effect {
  const rawEffect = rawClause.effect;
  if (!rawEffect || typeof rawEffect !== "object") {
    // Legacy or malformed clauses fall through to unmodeled.
    return { kind: "unmodeled" };
  }
  const candidate = rawEffect as Record<string, unknown>;
  const kind = candidate.kind;

  if (kind === "payment") {
    const assetKind = typeof candidate.assetKind === "string" ? candidate.assetKind : undefined;
    const cap =
      candidate.cap && typeof candidate.cap === "object" ? normalizeExpr(candidate.cap) : undefined;
    return {
      kind: "payment",
      payer: String(candidate.payer || "party"),
      payee: String(candidate.payee || "counterparty"),
      amount: normalizeExpr(candidate.amount),
      ...(cap ? { cap } : {}),
      ...(assetKind ? { assetKind } : {}),
    };
  }

  if (kind === "obligation") {
    const due =
      candidate.due && typeof candidate.due === "object"
        ? normalizeTemporalRule(candidate.due)
        : undefined;
    const curePeriod =
      candidate.curePeriod && typeof candidate.curePeriod === "object"
        ? normalizeTemporalRule(candidate.curePeriod)
        : undefined;
    return {
      kind: "obligation",
      actor: String(candidate.actor || "party"),
      action: String(candidate.action || "Perform obligation"),
      ...(due ? { due } : {}),
      ...(curePeriod ? { curePeriod } : {}),
    };
  }

  if (kind === "formula") {
    const cap =
      candidate.cap && typeof candidate.cap === "object" ? normalizeExpr(candidate.cap) : undefined;
    return {
      kind: "formula",
      outputVar: String(candidate.outputVar || "derived_value"),
      expr: normalizeExpr(candidate.expr),
      ...(cap ? { cap } : {}),
    };
  }

  if (kind === "accumulation") {
    const per = ACCUMULATION_UNITS.includes(candidate.per as AccumulationUnit)
      ? (candidate.per as AccumulationUnit)
      : "day";
    const cap =
      candidate.cap && typeof candidate.cap === "object" ? normalizeExpr(candidate.cap) : undefined;
    return {
      kind: "accumulation",
      per,
      rate: normalizeExpr(candidate.rate),
      ...(cap ? { cap } : {}),
    };
  }

  if (kind === "indemnification") {
    return {
      kind: "indemnification",
      indemnifier: String(candidate.indemnifier || "party"),
      indemnitee: String(candidate.indemnitee || "counterparty"),
      scope: String(candidate.scope || "see source text"),
      carveOuts: Array.isArray(candidate.carveOuts)
        ? candidate.carveOuts.map((v) => String(v))
        : [],
    };
  }

  if (kind === "default") {
    return {
      kind: "default",
      consequences: Array.isArray(candidate.consequences)
        ? candidate.consequences.map((v) => String(v))
        : [],
    };
  }

  return { kind: "unmodeled" };
}

function normalizeClause(rawClause: Record<string, unknown>): Clause {
  const sourceSpan = normalizeSourceSpan(rawClause.sourceSpan);
  const condition = normalizeBoolExpr(rawClause.condition);
  const semanticTag =
    typeof rawClause.semanticTag === "string" && rawClause.semanticTag
      ? rawClause.semanticTag
      : "unmodeled_section";
  return {
    id: String(rawClause.id),
    title: String(rawClause.title),
    sourceText: String(rawClause.sourceText),
    ...(sourceSpan ? { sourceSpan } : {}),
    modeled: Boolean(rawClause.modeled),
    semanticTag,
    ...(condition ? { condition } : {}),
    effect: normalizeEffect(rawClause),
  };
}

function normalizeIr(raw: unknown, sourceFile: string, contractText: string): ContractIR {
  const parsed = IrTopSchema.parse(raw);
  const clauses = parsed.clauses.map(normalizeClause);
  const clausesWithSpans = attachSourceSpans(contractText, clauses);

  return {
    contractId: parsed.contractId,
    title: parsed.title,
    currency: parsed.currency,
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
