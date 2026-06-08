import type { ContractIR, KnownSemanticTag } from "../types/ir.js";

export type ContractFamily = "credit_card" | "lease" | "generic";

export interface Archetype {
  id: string;
  label: string;
  intent: string;
}

const CREDIT_CARD_ARCHETYPES: Archetype[] = [
  {
    id: "on-time",
    label: "On-time full payment",
    intent:
      "Payment clears at or above the minimum before the due date; no late fee, no over-limit fee.",
  },
  {
    id: "late-payment",
    label: "Late payment, below minimum",
    intent:
      "Payment posted after the due date and below the required minimum, triggering the late-payment path.",
  },
  {
    id: "over-limit",
    label: "Over credit limit at statement close",
    intent:
      "Opening activity drives balance above the credit limit at statement close, triggering over-limit behavior.",
  },
];

const LEASE_ARCHETYPES: Archetype[] = [
  {
    id: "on-time",
    label: "On-time rent payment",
    intent: "Tenant pays full rent on or before the rent due date; no default.",
  },
  {
    id: "partial-payment",
    label: "Partial rent, triggers default review",
    intent:
      "Tenant pays less than the monthly rent, leaving a shortfall at the due-check and triggering the lease nonpayment path.",
  },
];

const GENERIC_ARCHETYPES: Archetype[] = [
  {
    id: "baseline",
    label: "Baseline review",
    intent:
      "Minimal timeline that exercises any modeled clause; safe default when contract family is unknown.",
  },
];

export function archetypesFor(family: ContractFamily): Archetype[] {
  switch (family) {
    case "credit_card":
      return CREDIT_CARD_ARCHETYPES;
    case "lease":
      return LEASE_ARCHETYPES;
    default:
      return GENERIC_ARCHETYPES;
  }
}

function hasModeledClause(
  ir: ContractIR,
  matcher: (clause: ContractIR["clauses"][number]) => boolean,
): boolean {
  return ir.clauses.some((clause) => clause.modeled && matcher(clause));
}

export function contractFamily(ir: ContractIR): ContractFamily {
  const title = `${ir.title} ${ir.contractId}`.toLowerCase();

  // Lease signals rely on lease-specific tags that cannot appear on credit cards.
  const hasLeaseSpecificTag = hasModeledClause(
    ir,
    (clause) =>
      clause.semanticTag === ("rent_obligation" satisfies KnownSemanticTag) ||
      clause.semanticTag === ("base_rent" satisfies KnownSemanticTag) ||
      clause.semanticTag === ("tenant_default" satisfies KnownSemanticTag),
  );
  const hasLeaseSignals = title.includes("lease") || hasLeaseSpecificTag;

  // Credit-card signals must include at least one credit-card-specific tag.
  // `late_payment_fee` alone is ambiguous (leases also have late-rent fees).
  const hasCreditCardSpecificTag = hasModeledClause(
    ir,
    (clause) =>
      clause.semanticTag === ("minimum_payment_obligation" satisfies KnownSemanticTag) ||
      clause.semanticTag === ("minimum_payment_formula" satisfies KnownSemanticTag) ||
      clause.semanticTag === ("over_limit_fee" satisfies KnownSemanticTag) ||
      clause.semanticTag === ("credit_limit_obligation" satisfies KnownSemanticTag) ||
      clause.semanticTag === ("foreign_transaction_fee" satisfies KnownSemanticTag),
  );
  const hasCreditSignals =
    hasCreditCardSpecificTag || title.includes("credit card") || title.includes("cardholder");

  // Specific signals win over ambiguous ones: a lease with a late-rent fee
  // stays a lease unless it ALSO has credit-card-specific tags.
  if (hasLeaseSpecificTag && !hasCreditCardSpecificTag) return "lease";
  if (hasCreditSignals) return "credit_card";
  if (hasLeaseSignals) return "lease";
  return "generic";
}
