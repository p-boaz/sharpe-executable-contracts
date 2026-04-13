import { daysBetween } from "../util/date.js";
import type { ScenarioEvent, ScenarioEventType } from "../types/scenario.js";

// Minimal obligation shape for matching. Callers extract this from a
// `Clause` whose `effect.kind === "obligation"` (id from clause, actor/action
// from effect).
export interface ObligationForMatching {
  id: string;
  actor: string;
  action: string;
}

export type MatchReason = "clauseId" | "actor+verb+window" | "no-match";

export interface MatchResult {
  matched: boolean;
  reason: MatchReason;
}

// Maps obligation action verbs (parsed out of clause.action) to the event
// types we accept as "performing" the obligation. Keep small and honest —
// if a verb isn't here, the matcher can only match via explicit clauseId.
const VERB_TO_EVENT_TYPES: Record<string, ScenarioEventType[]> = {
  pay: ["payment"],
  deliver: ["delivery"],
  notify: ["notice"],
};

// Extract the leading verb of an obligation action phrase, lower-cased.
// e.g. "Pay monthly rent" -> "pay"; "Deliver conforming goods" -> "deliver".
export function obligationVerb(action: string): string {
  const match = action.trim().toLowerCase().match(/^[a-z]+/);
  return match ? match[0] : "";
}

// Lookup helper the matcher uses. Exported for tests.
export function eventTypesForVerb(verb: string): ScenarioEventType[] {
  return VERB_TO_EVENT_TYPES[verb] ?? [];
}

// Absolute day difference. `daysBetween` throws on reverse order, so we
// always pass the earlier date first. Returns null if either date is not a
// parseable ISO date (e.g. the symbolic "see_source_text" placeholder that
// leaks through from the IR when a temporal rule is under-specified).
function absDays(aDate: string, bDate: string): number | null {
  try {
    return aDate <= bDate ? daysBetween(aDate, bDate) : daysBetween(bDate, aDate);
  } catch {
    return null;
  }
}

/**
 * Hybrid event-to-obligation match used by the generic executor (T22).
 *
 * Rule (in priority order):
 *   1. EXPLICIT:  event.metadata.clauseId === obligation.id
 *                 -> matched, reason="clauseId"
 *   2. FALLBACK:  event.metadata.actor === obligation.actor
 *                 AND event.type ∈ eventTypesForVerb(verb(obligation.action))
 *                 AND |event.date - resolvedDueDate| ≤ windowDays
 *                 -> matched, reason="actor+verb+window"
 *   3. else       -> not matched, reason="no-match"
 *
 * The actor+verb+window fallback exists so scenarios without explicit binding
 * still produce meaningful execution; the window stops a payment on 2027-05-01
 * from matching an obligation due on 2026-01-01.
 */
export function matchEventToObligation(
  event: ScenarioEvent,
  obligation: ObligationForMatching,
  resolvedDueDate: string,
  windowDays: number = 7,
): MatchResult {
  const explicitClauseId = event.metadata?.clauseId;
  if (typeof explicitClauseId === "string" && explicitClauseId === obligation.id) {
    return { matched: true, reason: "clauseId" };
  }

  const actor = event.metadata?.actor;
  if (typeof actor !== "string" || actor !== obligation.actor) {
    return { matched: false, reason: "no-match" };
  }

  const allowedTypes = eventTypesForVerb(obligationVerb(obligation.action));
  if (!allowedTypes.includes(event.type)) {
    return { matched: false, reason: "no-match" };
  }

  const distance = absDays(event.date, resolvedDueDate);
  if (distance === null || distance > windowDays) {
    return { matched: false, reason: "no-match" };
  }

  return { matched: true, reason: "actor+verb+window" };
}
