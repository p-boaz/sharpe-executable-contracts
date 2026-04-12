import { daysBetween } from "../util/date.js";
import { max, round2 } from "../util/math.js";
import type { ExecutionResult, Breach, LedgerEntry } from "../types/execution.js";
import type { ContractIR } from "../types/ir.js";
import type { Scenario } from "../types/scenario.js";

interface MutableObligation {
  id: string;
  clauseId: string;
  dueDate: string;
  amountDue: number;
  amountPaid: number;
  status: "open" | "met" | "missed" | "partial";
}

function findFeeAmount(ir: ContractIR, feeType: "late_payment" | "over_limit"): number {
  const feeClause = ir.clauses.find(
    (
      c,
    ): c is Extract<ContractIR["clauses"][number], { kind: "fee" }> =>
      c.kind === "fee" && c.feeType === feeType,
  );
  if (!feeClause) return 0;
  return feeClause.amountType === "fixed" ? feeClause.amountValue : 0;
}

function findClauseId(
  ir: ContractIR,
  matcher: (clause: ContractIR["clauses"][number]) => boolean,
): string | undefined {
  return ir.clauses.find(matcher)?.id;
}

function minimumPayment(balance: number): number {
  if (balance <= 15) return round2(balance);
  return max(round2(balance * 0.03), 15);
}

function asLedger(
  id: string,
  date: string,
  kind: LedgerEntry["kind"],
  amount: number,
  balanceAfter: number,
  description: string,
  clauseId?: string,
): LedgerEntry {
  const base: LedgerEntry = {
    id,
    date,
    kind,
    amount: round2(amount),
    balanceAfter: round2(balanceAfter),
    description,
  };
  if (clauseId) base.clauseId = clauseId;
  return base;
}

function pushBreach(
  list: Breach[],
  id: string,
  date: string,
  type: Breach["type"],
  description: string,
  clauseId?: string,
): void {
  const base: Breach = {
    id,
    date,
    type,
    description,
  };
  if (clauseId) base.clauseId = clauseId;
  list.push(base);
}

export function executeContract(ir: ContractIR, scenario: Scenario): ExecutionResult {
  const events = [...scenario.events].sort((a, b) => {
    const dateCompare = a.date.localeCompare(b.date);
    if (dateCompare !== 0) return dateCompare;
    return a.id.localeCompare(b.id);
  });

  const ledger: LedgerEntry[] = [];
  const breaches: Breach[] = [];
  const obligations: MutableObligation[] = [];

  const apr = scenario.initialState.apr;
  const dailyRate = apr / 100 / 365;
  const lateFee = findFeeAmount(ir, "late_payment");
  const overLimitFee = findFeeAmount(ir, "over_limit");
  const minimumPaymentClauseId = findClauseId(
    ir,
    (c) => c.kind === "obligation" && c.id === "clause.obligation.minimum_payment",
  );
  const lateFeeClauseId = findClauseId(
    ir,
    (c) => c.kind === "fee" && c.feeType === "late_payment",
  );
  const overLimitClauseId = findClauseId(
    ir,
    (c) => c.kind === "fee" && c.feeType === "over_limit",
  );
  const defaultClauseId = findClauseId(ir, (c) => c.kind === "default");

  let balance = round2(scenario.initialState.balance);
  let totalInterestCharged = 0;
  let totalFeesCharged = 0;
  let totalPaid = 0;
  let lastAccrualDate = events[0]?.date || scenario.initialState.statementDate;
  let activeObligation: MutableObligation | null = null;

  for (const event of events) {
    const elapsedDays = daysBetween(lastAccrualDate, event.date);
    if (elapsedDays > 0 && balance > 0) {
      const accruedInterest = round2(balance * dailyRate * elapsedDays);
      if (accruedInterest > 0) {
        balance = round2(balance + accruedInterest);
        totalInterestCharged = round2(totalInterestCharged + accruedInterest);
        ledger.push(
          asLedger(
            `interest-${event.id}`,
            event.date,
            "interest",
            accruedInterest,
            balance,
            `Interest accrued for ${elapsedDays} day(s) at APR ${apr}%`,
            findClauseId(ir, (c) => c.kind === "formula" && c.outputVar === "apr_nominal"),
          ),
        );
      }
    }
    lastAccrualDate = event.date;

    switch (event.type) {
      case "purchase": {
        const amount = round2(event.amount || 0);
        balance = round2(balance + amount);
        ledger.push(
          asLedger(event.id, event.date, "purchase", amount, balance, "Purchase posted"),
        );
        break;
      }
      case "cash_advance": {
        const amount = round2(event.amount || 0);
        balance = round2(balance + amount);
        ledger.push(
          asLedger(
            event.id,
            event.date,
            "cash_advance",
            amount,
            balance,
            "Cash advance posted",
          ),
        );
        break;
      }
      case "payment": {
        const amount = round2(event.amount || 0);
        balance = round2(Math.max(0, balance - amount));
        totalPaid = round2(totalPaid + amount);

        if (activeObligation) {
          activeObligation.amountPaid = round2(activeObligation.amountPaid + amount);
        }

        ledger.push(asLedger(event.id, event.date, "payment", -amount, balance, "Payment posted"));
        break;
      }
      case "statement_close": {
        const amountDue = minimumPayment(balance);
        activeObligation = {
          id: `obl-${event.id}`,
          clauseId: minimumPaymentClauseId || "clause.obligation.minimum_payment",
          dueDate: scenario.initialState.dueDate,
          amountDue,
          amountPaid: 0,
          status: "open",
        };
        obligations.push(activeObligation);

        ledger.push(
          asLedger(
            event.id,
            event.date,
            "statement",
            amountDue,
            balance,
            `Statement closed. Minimum due: $${amountDue.toFixed(2)}`,
            activeObligation.clauseId,
          ),
        );

        if (balance > scenario.initialState.creditLimit && overLimitFee > 0) {
          balance = round2(balance + overLimitFee);
          totalFeesCharged = round2(totalFeesCharged + overLimitFee);
          ledger.push(
            asLedger(
              `fee-over-limit-${event.id}`,
              event.date,
              "fee",
              overLimitFee,
              balance,
              "Over-limit fee applied",
              overLimitClauseId,
            ),
          );
          pushBreach(
            breaches,
            `breach-over-limit-${event.id}`,
            event.date,
            "over_limit",
            "Balance exceeded credit limit at statement close",
            overLimitClauseId,
          );
        }
        break;
      }
      case "due_check": {
        if (!activeObligation) break;

        if (activeObligation.amountPaid >= activeObligation.amountDue) {
          activeObligation.status = "met";
        } else if (activeObligation.amountPaid > 0) {
          activeObligation.status = "partial";
        } else {
          activeObligation.status = "missed";
        }

        if (activeObligation.status !== "met") {
          if (lateFee > 0) {
            balance = round2(balance + lateFee);
            totalFeesCharged = round2(totalFeesCharged + lateFee);
            ledger.push(
              asLedger(
                `fee-late-${event.id}`,
                event.date,
                "fee",
                lateFee,
                balance,
                "Late payment fee applied",
                lateFeeClauseId,
              ),
            );
          }

          pushBreach(
            breaches,
            `breach-late-${event.id}`,
            event.date,
            "late_payment",
            "Minimum payment was not fully paid by due-check date",
            minimumPaymentClauseId,
          );
          pushBreach(
            breaches,
            `breach-default-${event.id}`,
            event.date,
            "default",
            "Default condition triggered by late payment",
            defaultClauseId,
          );
        }

        break;
      }
      case "notice": {
        ledger.push(asLedger(event.id, event.date, "notice", 0, balance, "Notice event recorded"));
        break;
      }
      default:
        break;
    }
  }

  const finalizedObligations = obligations.map((o) => ({
    id: o.id,
    clauseId: o.clauseId,
    dueDate: o.dueDate,
    amountDue: round2(o.amountDue),
    amountPaid: round2(o.amountPaid),
    status: o.status === "open" ? "partial" : o.status,
  }));

  return {
    ledger,
    breaches,
    obligations: finalizedObligations,
    summary: {
      endingBalance: round2(balance),
      totalInterestCharged: round2(totalInterestCharged),
      totalFeesCharged: round2(totalFeesCharged),
      totalPaid: round2(totalPaid),
      breached: breaches.length > 0,
    },
  };
}
