export type ClauseKind = "obligation" | "formula" | "fee" | "default" | "condition" | string;

export interface Expr {
  op: string;
  value?: number | string | boolean;
  name?: string;
  args?: Expr[];
}

export interface Clause {
  id: string;
  kind: ClauseKind;
  title?: string;
  modeled?: boolean;
  sourceText?: string;
  actor?: string;
  action?: string;
  due?: { type?: string; value?: string };
  outputVar?: string;
  expr?: Expr;
  feeType?: string;
  amountType?: string;
  amountValue?: number;
  triggerDescription?: string;
  consequences?: string[];
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
  assumptions?: string[];
  initialState?: Record<string, unknown>;
  events?: ScenarioEvent[];
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
