export type ClauseKind = "definition" | "obligation" | "formula" | "fee" | "default";

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
  type: "calendar_days" | "business_days" | "on_date";
  value: number | string;
  anchor?: string;
}

export interface BoolExpr {
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "and" | "or";
  left?: string | number | BoolExpr;
  right?: string | number | BoolExpr;
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

export interface ClauseBase {
  id: string;
  title: string;
  kind: ClauseKind;
  sourceText: string;
  sourceSpan?: SourceSpan;
  modeled: boolean;
}

export interface ObligationClause extends ClauseBase {
  kind: "obligation";
  actor: string;
  action: string;
  due: TemporalRule;
  condition?: BoolExpr;
  curePeriod?: TemporalRule;
}

export interface FormulaClause extends ClauseBase {
  kind: "formula";
  outputVar: string;
  expr: Expr;
}

export interface FeeClause extends ClauseBase {
  kind: "fee";
  feeType: "late_payment" | "over_limit" | "returned_payment" | "foreign_txn";
  amountType: "fixed" | "percent";
  amountValue: number;
  triggerDescription: string;
}

export interface DefaultClause extends ClauseBase {
  kind: "default";
  triggerDescription: string;
  consequences: string[];
}

export type Clause = ObligationClause | FormulaClause | FeeClause | DefaultClause;

export interface ContractIR {
  contractId: string;
  title: string;
  jurisdiction?: string;
  currency: "USD";
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
      mode: "llm" | "heuristic_fallback";
    };
  };
}
