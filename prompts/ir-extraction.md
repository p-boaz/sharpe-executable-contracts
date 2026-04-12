Extract a deterministic executable contract IR.

Rules:
- Keep only clauses that can be executed as code.
- Preserve source snippets for traceability.
- Prefer explicit formulas and fee triggers.
- Mark unsupported clauses as unmodeled (do not invent details).
