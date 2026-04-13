// Path B shape. All clauses carry a `semanticTag` + `effect`; the effect's
// discriminator lives on `effect.kind`. The old top-level `kind` is kept as an
// optional alias so legacy artifacts still parse, but new reads should look at
// `effect.kind`.
export type EffectKind =
  | "payment"
  | "obligation"
  | "formula"
  | "accumulation"
  | "indemnification"
  | "default"
  | "unmodeled";

export interface Expr {
  op: string;
  value?: number | string | boolean;
  name?: string;
  args?: Expr[];
}

export interface BoolExpr {
  op: string;
  left?: string | number | boolean | BoolExpr;
  right?: string | number | boolean | BoolExpr;
  args?: BoolExpr[];
}

export interface TemporalRule {
  type?: string;
  value?: string | number;
  anchor?: string;
  direction?: string;
}

export interface Effect {
  kind: EffectKind;
  // payment
  payer?: string;
  payee?: string;
  amount?: Expr;
  cap?: Expr;
  assetKind?: string;
  // obligation
  actor?: string;
  action?: string;
  due?: TemporalRule;
  curePeriod?: TemporalRule;
  // formula
  outputVar?: string;
  expr?: Expr;
  // accumulation
  per?: string;
  rate?: Expr;
  // indemnification
  indemnifier?: string;
  indemnitee?: string;
  scope?: string;
  carveOuts?: string[];
  // default
  consequences?: string[];
}

export interface Clause {
  id: string;
  title?: string;
  modeled?: boolean;
  sourceText?: string;
  semanticTag?: string;
  condition?: BoolExpr;
  effect?: Effect;
}

export interface Party { id: string; name: string; role: string; }
export interface Definition { id: string; term: string; meaning: string; sourceText?: string; }

export interface IR {
  title?: string;
  contractId?: string;
  currency?: string;
  jurisdiction?: string;
  parties?: Party[];
  definitions?: Definition[];
  clauses?: Clause[];
  metadata?: { sourceFile?: string; clauseCount?: number; modeledClauseCount?: number };
}

export interface ScenarioEvent {
  id: string;
  date?: string;
  type: string;
  amount?: number;
  metadata?: Record<string, unknown>;
}
export interface Scenario {
  scenarioId?: string;
  archetype?: string;
  label?: string;
  assumptions?: string[];
  initialState?: Record<string, unknown>;
  events?: ScenarioEvent[];
  metadata?: {
    generation?: {
      llmRequested?: boolean;
      llmUsed?: boolean;
      mode?: string;
      archetype?: string;
      contractHash?: string;
      contractChars?: number;
      promptTruncated?: boolean;
      validationNote?: string;
    };
  };
}

export interface ContractMeta {
  contractId: string;
  title: string;
  family: string;
  sourceFile?: string;
  irHash?: string;
  englishHash?: string;
  stages?: {
    irGeneratedAt?: string;
    scenariosGeneratedAt?: string;
    lastExecutedAt?: string;
    englishGeneratedAt?: string;
  };
  scenarios: {
    archetype: string;
    label: string;
    scenarioId: string;
    endingBalance?: number;
    breached?: boolean;
    breachCount?: number;
  }[];
}

export interface ContractOption {
  key: string;
  sourceFile: string;
  title: string;
  processed: boolean;
  irReady: boolean;
  scenariosReady: boolean;
  origin: "bundled" | "uploaded";
  hasPreloaded: boolean;
}

export interface LedgerEntry {
  id: string;
  date?: string;
  kind: string;
  amount: number;
  balanceAfter: number;
  description?: string;
  clauseId?: string;
}
export interface Obligation {
  id: string;
  clauseId: string;
  dueDate?: string;
  amountDue?: number;
  amountPaid?: number;
  status: string;
}
export interface Breach {
  id: string;
  clauseId: string;
  date?: string;
  description?: string;
  type?: string;
}
export interface RunResult {
  ledger?: LedgerEntry[];
  obligations?: Obligation[];
  breaches?: Breach[];
  summary?: {
    endingBalance?: number;
    totalPaid?: number;
    totalInterestCharged?: number;
    totalFeesCharged?: number;
    breached?: boolean;
  };
}

export interface RunBundle {
  ir: IR;
  scenario: Scenario | null;
  runResult: RunResult | null;
  english: string;
  contract: string;
}
