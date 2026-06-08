import type { ContractIR, Definition } from "../types/ir.js";

// Case-insensitive, whitespace-tolerant lookup. `"Closing Date"`,
// `"closing_date"`, and `"closingDate"` all resolve to the same entry.
export function findDefinition(
  term: string,
  ir: ContractIR,
): Definition | undefined {
  const norm = normalize(term);
  if (!norm) return undefined;
  return ir.definitions.find(
    (d) => normalize(d.term) === norm || normalize(d.id) === norm,
  );
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s-]+/g, "");
}

const MONTHS: Record<string, string> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

// Parses human dates out of definition meanings: "April 1, 2009",
// "February 1, 2007", "3 November 2004", "2026-04-01". Returns an ISO
// `YYYY-MM-DD` string or null. Not a general-purpose parser — only
// handles forms the extractor tends to emit.
export function extractIsoDate(text: string): string | null {
  if (!text) return null;
  const isoMatch = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const mdyMatch = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(\d{4})\b/i,
  );
  if (mdyMatch) {
    const m = MONTHS[mdyMatch[1]!.toLowerCase()];
    const d = mdyMatch[2]!.padStart(2, "0");
    return `${mdyMatch[3]}-${m}-${d}`;
  }
  const dmyMatch = text.match(
    /\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i,
  );
  if (dmyMatch) {
    const m = MONTHS[dmyMatch[2]!.toLowerCase()];
    const d = dmyMatch[1]!.padStart(2, "0");
    return `${dmyMatch[3]}-${m}-${d}`;
  }
  return null;
}

// Given a symbolic date-like value from a TemporalRule (e.g.
// `"closing_date"`, `"effective_date"`), try to find a concrete ISO date
// by looking up the matching definition's meaning. Returns null if no
// definition exists or the meaning has no parseable date.
export function resolveTermToDate(term: string, ir: ContractIR): string | null {
  const def = findDefinition(term, ir);
  if (!def) return null;
  return extractIsoDate(def.meaning);
}

// Returns the definitions whose `term` appears verbatim (case-insensitive,
// whole-phrase) in the given text. Used by the decompiler to show which
// defined terms a clause body references.
export function findReferencedTerms(
  text: string,
  ir: ContractIR,
): Definition[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const found: Definition[] = [];
  const seen = new Set<string>();
  for (const def of ir.definitions) {
    const term = def.term.trim().toLowerCase();
    if (!term || seen.has(def.id)) continue;
    // Require a word-boundary match so `"Fund"` doesn't match inside
    // `"funding"`; simple regex escape since terms come from source text.
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escaped}\\b`, "i");
    if (pattern.test(lower)) {
      found.push(def);
      seen.add(def.id);
    }
  }
  return found;
}
