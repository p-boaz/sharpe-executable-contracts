export interface LedgerEntry {
  id: string;
  date: string;
  kind: "purchase" | "cash_advance" | "payment" | "interest" | "fee" | "statement" | "notice";
  amount: number;
  balanceAfter: number;
  clauseId?: string;
  description: string;
}

export interface Breach {
  id: string;
  date: string;
  type: "late_payment" | "default" | "over_limit";
  clauseId?: string;
  description: string;
}

export interface ObligationStatus {
  id: string;
  clauseId: string;
  dueDate: string;
  amountDue: number;
  amountPaid: number;
  status: "met" | "missed" | "partial";
}

export interface ExecutionResult {
  ledger: LedgerEntry[];
  breaches: Breach[];
  obligations: ObligationStatus[];
  summary: {
    endingBalance: number;
    totalInterestCharged: number;
    totalFeesCharged: number;
    totalPaid: number;
    breached: boolean;
  };
}
