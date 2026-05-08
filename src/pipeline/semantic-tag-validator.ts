import type { Clause } from "../types/ir.js";
import { isKnownSemanticTag } from "../types/ir.js";

export interface UnknownTag {
  clauseId: string;
  tag: string;
}

export function findUnknownSemanticTags(clauses: Clause[]): UnknownTag[] {
  const out: UnknownTag[] = [];
  for (const clause of clauses) {
    if (!isKnownSemanticTag(clause.semanticTag)) {
      out.push({ clauseId: clause.id, tag: clause.semanticTag });
    }
  }
  return out;
}

/**
 * Build a repair prompt listing the unknown tags for a single LLM retry.
 * The prompt is intentionally short — it tells the model what's wrong and
 * the closed vocabulary; the original system prompt + contract text remain
 * unchanged in the retry call.
 */
export function buildTagRepairPrompt(unknown: UnknownTag[], knownTags: readonly string[]): string {
  const offenders = unknown.map((u) => `  - clause "${u.clauseId}" emitted "${u.tag}"`).join("\n");
  return [
    "Your previous extraction emitted semanticTag values that are not in the closed vocabulary.",
    "Re-extract using ONLY tags from the closed vocabulary.",
    "Offenders:",
    offenders,
    "",
    "Closed vocabulary (use ONLY these, in underscore form):",
    knownTags.map((t) => `  - ${t}`).join("\n"),
    "",
    "If a clause genuinely doesn't fit any tag, set semanticTag: \"unmodeled_section\" and modeled: false.",
  ].join("\n");
}
