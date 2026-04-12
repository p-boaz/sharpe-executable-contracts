Generate one concrete scenario with realistic dates/events/amounts for the provided contract IR.

Rules:
- Provide a full event timeline.
- Make assumptions explicit and inspectable.
- Keep `initialState` generic and tied to IR-extracted fields when possible.
- If the IR does not support credit-card execution semantics, return a plausible generic scenario rather than inventing unsupported finance events.
- Output strict JSON only.
