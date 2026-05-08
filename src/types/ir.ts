// Path B IR: effect-based clause model.
//
// A clause has one effect. The effect says what happens if the clause fires.
// The clause also carries an optional `condition` that gates firing.
// `semanticTag` is an open string — e.g. `late_payment_fee`,
// `liquidated_damages`, `sales_commission`, `non_compete_restriction`.
// Credit-card-specific enums have been removed.

export interface Party {
  id: string;
  role: string;
  name: string;
}

export interface Definition {
  id: string;
  term: string;
  meaning: string;
  sourceText: string;
}

export interface TemporalRule {
  type: "calendar_days" | "business_days" | "months" | "years" | "on_date";
  // `value` is a number for durations, a string for absolute / symbolic anchors
  // (e.g. "2026-04-01", "closing_date", "4:00 PM ET").
  value: number | string;
  anchor?: string;
  // `direction` disambiguates "N days after anchor" vs "N days before anchor".
  // Default "after" when omitted.
  direction?: "before" | "after";
  // Compound durations: "14 months + 60 days grace period" is expressed as
  // `{ type: "months", value: 14, graceAfter: { type: "calendar_days", value: 60 } }`.
  graceAfter?: TemporalRule;
}

export interface BoolExpr {
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "and" | "or" | "not";
  left?: string | number | boolean | BoolExpr;
  right?: string | number | boolean | BoolExpr;
  args?: BoolExpr[];
}

export interface Expr {
  op: "const" | "var" | "add" | "sub" | "mul" | "div" | "max" | "min";
  value?: number;
  name?: string;
  args?: Expr[];
}

export interface SourceSpan {
  start: number;
  end: number;
}

export type AccumulationUnit =
  | "day"
  | "month"
  | "year"
  | "kg"
  | "watt"
  | "usd_raised"
  | "unit";

export type Effect =
  | {
      kind: "payment";
      payer: string;
      payee: string;
      amount: Expr;
      cap?: Expr;
      // `assetKind` is open-string; defaults to the contract's `currency` when omitted.
      // Examples: "USD", "shares:a_plus_equity_fully_diluted", "shares:xodtec_common".
      assetKind?: string;
    }
  | {
      kind: "obligation";
      actor: string;
      action: string;
      due?: TemporalRule;
      curePeriod?: TemporalRule;
    }
  | {
      kind: "formula";
      outputVar: string;
      expr: Expr;
      cap?: Expr;
    }
  | {
      kind: "accumulation";
      per: AccumulationUnit;
      rate: Expr;
      cap?: Expr;
    }
  | {
      kind: "indemnification";
      indemnifier: string;
      indemnitee: string;
      scope: string;
      carveOuts: string[];
    }
  | {
      kind: "default";
      consequences: string[];
    }
  | {
      kind: "unmodeled";
    };

/**
 * Closed vocabulary of semanticTags the executor recognizes.
 * Extractor output is validated against this list; unknown tags trigger
 * a single LLM repair retry, then are coerced to "unmodeled_section"
 * if still unrecognized.
 */
export const KNOWN_SEMANTIC_TAGS = [
  // credit-card archetype
  "late_payment_fee",
  "over_limit_fee",
  "returned_payment_fee",
  "foreign_transaction_fee",
  "minimum_payment_obligation",
  "minimum_payment_formula",
  "credit_limit_obligation",
  "illegal_use_default",
  "apr_nominal",
  "grace_period_obligation",
  "payment_default",
  // lease archetype
  "rent_obligation",
  "base_rent",
  "tenant_default",
  "lease_term",
  "late_rent_fee",
  "security_deposit",
  "operating_expense_pass_through",
  "renewal_option",
  "tenant_indemnifies_landlord",
  // employment archetype
  "employment_term",
  "recurring_base_salary",
  "without_cause_severance",
  "without_cause_termination_notice",
  "employee_voluntary_termination_notice",
  "cause_termination",
  "non_compete_restriction",
  "non_compete_extension_salary",
  "non_solicit_customers",
  "non_solicit_employees",
  // services / engagement archetype
  "engagement_term",
  "termination_notice",
  "voluntary_termination_notice",
  "material_breach_termination",
  "fee_dispute_notice",
  "late_trading_cutoff",
  "indemnity_notice_obligation",
  "administrative_fees",
  "sales_commission",
  "recurring_support_fee",
  "expense_reimbursement_cap",
  "underwriting_compensation_cap",
  "service_provider_indemnifies_distributor_and_funds",
  "distributor_indemnifies_service_provider",
  // procurement archetype
  "firm_fixed_price",
  "optional_payload_unit_price",
  "net_payment_terms",
  "on_time_delivery_incentive",
  "holdback_amount",
  "option_exercise_window",
  // securities / M&A archetype
  "target_share_transfer",
  "acquirer_equity_issuance",
  "closing_date",
  "closing_delivery",
  "mutual_indemnification_on_reps",
  "attorneys_fees_reimbursement",
  // meta
  "unmodeled_section",
  "unmodeled_summary",
] as const;

export type KnownSemanticTag = (typeof KNOWN_SEMANTIC_TAGS)[number];

export function isKnownSemanticTag(tag: string): tag is KnownSemanticTag {
  return (KNOWN_SEMANTIC_TAGS as readonly string[]).includes(tag);
}

export interface Clause {
  id: string;
  title: string;
  sourceText: string;
  sourceSpan?: SourceSpan;
  modeled: boolean;
  // Open-string tag for the clause's domain meaning.
  // Conventions are documented per contract family in `expectations/*.yaml`.
  semanticTag: string;
  // Gating condition. Clauses without a condition fire unconditionally when
  // the executor visits them.
  condition?: BoolExpr;
  effect: Effect;
}

export interface ContractIR {
  contractId: string;
  title: string;
  jurisdiction?: string;
  // Free-string (e.g. "USD", "EUR"). Was a literal type in the prior IR.
  currency: string;
  parties: Party[];
  definitions: Definition[];
  clauses: Clause[];
  metadata: {
    sourceFile: string;
    extractionHash: string;
    extractorVersion: string;
    clauseCount: number;
    modeledClauseCount: number;
    extraction: {
      llmRequested: boolean;
      llmUsed: boolean;
      mode: "llm";
    };
    // Populated when the normalizer had to replace malformed Expr nodes with
    // {op:"const",value:0}. Surfaces silent zero-coercions (e.g. LLM emitted
    // a bare number for `effect.amount`) so downstream UI and reviewers can
    // see which clauses lost numeric fidelity instead of executing to $0.
    extractionWarnings?: string[];
  };
}
