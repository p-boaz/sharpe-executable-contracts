"use client";

import { useState, useCallback, useMemo, useEffect } from "react";
import { useRouter } from "next/navigation";
import type {
  Breach,
  Clause,
  ContractMeta,
  Expr,
  IR,
  LedgerEntry,
  Obligation,
  RunResult,
  Scenario,
} from "./lib/types";

interface Props {
  contracts: ContractMeta[];
  selectedContractId: string;
  meta: ContractMeta;
  ir: IR;
  contract: string;
  english: string;
  scenario: Scenario | null;
  execution: RunResult | null;
  selectedArchetype: string | null;
}

type Link = { clauseId?: string; eventId?: string };

function fmtMoney(n: number | undefined | null, currency = "USD"): string {
  if (n == null || Number.isNaN(n)) return "—";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return "$" + Number(n).toFixed(2);
  }
}

function fmtDate(d?: string): string {
  if (!d) return "";
  try {
    return new Date(d + "T00:00:00").toLocaleDateString("en-US", {
      month: "short",
      day: "2-digit",
      year: "numeric",
    });
  } catch {
    return d;
  }
}

function renderExpr(e: Expr | undefined): string {
  if (!e) return "";
  if (e.op === "const") return String(e.value);
  if (e.op === "var") return String(e.name);
  const a = (i: number) => renderExpr(e.args?.[i]);
  if (e.op === "mul") return `(${a(0)} × ${a(1)})`;
  if (e.op === "add") return `(${a(0)} + ${a(1)})`;
  if (e.op === "sub") return `(${a(0)} − ${a(1)})`;
  if (e.op === "div") return `(${a(0)} ÷ ${a(1)})`;
  if (e.op === "max") return `max(${e.args?.map(renderExpr).join(", ")})`;
  if (e.op === "min") return `min(${e.args?.map(renderExpr).join(", ")})`;
  return JSON.stringify(e);
}

function ClauseBody({ c }: { c: Clause }) {
  const effect = c.effect;
  if (!effect) return <div className="muted italic">{c.title ?? ""}</div>;

  const tagLabel = c.semanticTag ? (
    <span className="mono" style={{ opacity: 0.7 }}>
      {c.semanticTag}
    </span>
  ) : null;

  if (effect.kind === "formula" && effect.outputVar) {
    return (
      <div>
        {tagLabel ? <>{tagLabel} · </> : null}
        computes <span className="mono">{effect.outputVar}</span>
        {" = "}
        <span className="mono">{renderExpr(effect.expr)}</span>
      </div>
    );
  }
  if (effect.kind === "payment") {
    const amountText = effect.amount?.op === "const" ? fmtMoney(Number(effect.amount.value)) : renderExpr(effect.amount);
    return (
      <div>
        {tagLabel ? <>{tagLabel} · </> : null}
        {effect.payer ?? "party"} pays {effect.payee ?? "counterparty"}{" "}
        <span className="mono">{amountText}</span>
        {effect.assetKind ? <> [{effect.assetKind}]</> : null}
      </div>
    );
  }
  if (effect.kind === "obligation") {
    return (
      <div>
        {tagLabel ? <>{tagLabel} · </> : null}
        {effect.actor ?? "party"} must {effect.action ?? "perform duty"}
        {effect.due?.value ? (
          <>
            {" "}
            ({effect.due?.type ?? "due"}: <span className="mono">{effect.due.value}</span>
            {effect.due?.direction ? ` ${effect.due.direction}` : ""})
          </>
        ) : null}
      </div>
    );
  }
  if (effect.kind === "accumulation") {
    return (
      <div>
        {tagLabel ? <>{tagLabel} · </> : null}
        accumulate <span className="mono">{renderExpr(effect.rate)}</span> per {effect.per}
      </div>
    );
  }
  if (effect.kind === "indemnification") {
    return (
      <div>
        {tagLabel ? <>{tagLabel} · </> : null}
        {effect.indemnifier ?? "party"} indemnifies {effect.indemnitee ?? "counterparty"}
        {effect.scope ? <> for {effect.scope}</> : null}
      </div>
    );
  }
  if (effect.kind === "default") {
    return (
      <>
        {tagLabel ? <div>{tagLabel}</div> : null}
        {effect.consequences?.length ? (
          <div style={{ marginTop: 4 }}>Consequences: {effect.consequences.join("; ")}</div>
        ) : null}
      </>
    );
  }
  if (effect.kind === "unmodeled") {
    return <div className="muted italic">(unmodeled — see source text)</div>;
  }
  return <div className="muted italic">{c.title ?? ""}</div>;
}

export default function Dossier({
  contracts,
  selectedContractId,
  meta,
  ir,
  contract,
  english,
  scenario,
  execution,
  selectedArchetype,
}: Props) {
  const router = useRouter();
  const [hover, setHover] = useState<Link>({});
  const [locked, setLocked] = useState<Link>({});
  const [ranFor, setRanFor] = useState<string | null>(null);
  const [liveExecution, setLiveExecution] = useState<RunResult | null>(execution);
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  useEffect(() => {
    setRanFor(null);
    setLiveExecution(execution);
    setIsRunning(false);
    setRunError(null);
  }, [selectedContractId, selectedArchetype]);

  useEffect(() => {
    const clear = () => setLocked({});
    document.addEventListener("click", clear);
    return () => document.removeEventListener("click", clear);
  }, []);

  const linkClass = useCallback(
    (clauseId?: string, eventId?: string) => {
      const classes: string[] = [];
      const matchesHover =
        (clauseId && hover.clauseId === clauseId) ||
        (eventId && hover.eventId === eventId);
      const matchesLock =
        (clauseId && locked.clauseId === clauseId) ||
        (eventId && locked.eventId === eventId);
      if (matchesHover) classes.push(eventId && !clauseId ? "event-hover" : "linked-hover");
      if (matchesLock) classes.push("locked");
      return classes.join(" ");
    },
    [hover, locked],
  );

  const linkHandlers = useCallback(
    (clauseId?: string, eventId?: string) => ({
      onMouseEnter: () => setHover({ clauseId, eventId }),
      onMouseLeave: () => setHover({}),
      onClick: (evt: React.MouseEvent) => {
        evt.stopPropagation();
        setLocked((prev) =>
          prev.clauseId === clauseId && prev.eventId === eventId
            ? {}
            : { clauseId, eventId },
        );
      },
    }),
    [],
  );

  const currency = ir.currency ?? "USD";
  const summary = liveExecution?.summary ?? {};
  const runResultsVisible = ranFor === selectedArchetype && !!liveExecution;

  const englishBlocks = useMemo(() => {
    return english.split("\n").map((raw, i) => {
      if (!raw.trim()) return <span key={i} style={{ display: "block", height: 8 }} />;
      const m = raw.match(/^\s*-\s+(clause\.[a-z_.]+):\s*(.*)$/i);
      if (m) {
        const cid = m[1];
        return (
          <span
            key={i}
            className={`line clause-line ${linkClass(cid)}`}
            {...linkHandlers(cid)}
          >
            <span className="marker">§</span>
            <span className="cid">{cid}</span>
            {" — "}
            {m[2]}
          </span>
        );
      }
      const headMatch = /^(Parties:|Definitions:|Executable Clauses:|Modeled coverage.*)$/.exec(
        raw.trim(),
      );
      if (headMatch) {
        return (
          <span key={i} className="line head">
            {raw.trim()}
          </span>
        );
      }
      const isMeta = /^(Contract|Contract ID|Currency)/.test(raw);
      return (
        <span key={i} className={`line${isMeta ? " meta" : ""}`}>
          {raw}
        </span>
      );
    });
  }, [english, linkClass, linkHandlers]);

  const selectContract = (contractId: string) => {
    if (contractId !== selectedContractId) {
      router.push(`/?contract=${encodeURIComponent(contractId)}`);
    }
  };

  const selectScenario = (archetype: string) => {
    router.push(
      `/?contract=${encodeURIComponent(selectedContractId)}&scenario=${encodeURIComponent(archetype)}`,
    );
  };

  const runNow = async () => {
    if (!selectedArchetype || isRunning) return;
    setIsRunning(true);
    setRunError(null);
    try {
      const response = await fetch("/api/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contractId: selectedContractId,
          archetype: selectedArchetype,
        }),
      });
      const payload = (await response.json()) as {
        execution?: RunResult;
        error?: string;
      };
      if (!response.ok || !payload.execution) {
        throw new Error(payload.error || "Execution request failed");
      }
      setLiveExecution(payload.execution);
      setRanFor(selectedArchetype);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "Execution failed");
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <main className="sheet">
      <header className="topbar">
        <div>
          <div className="brand">Executable Contracts · pipeline viewer</div>
          <div className="contract-picker">
            <label htmlFor="contract-select">Contract</label>
            <select
              id="contract-select"
              value={selectedContractId}
              onChange={(e) => selectContract(e.target.value)}
            >
              {contracts.map((c) => (
                <option key={c.contractId} value={c.contractId}>
                  {c.title} ({c.family})
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="meta">
          <div>id: <strong>{meta.contractId}</strong></div>
          <div>
            {ir.parties?.map((p) => p.name).slice(0, 2).join(" ↔ ") || "—"}
            {" · "}
            {currency}
            {ir.metadata ? (
              <>
                {" "}
                · {ir.metadata.modeledClauseCount ?? 0}/{ir.metadata.clauseCount ?? 0} modeled
              </>
            ) : null}
          </div>
        </div>
      </header>

      <section className="zone">
        <div className="zone-label">
          Step 1 · Contract → IR + English
          <span className="hint">
            {" "}— the runtime parses the markdown on the left and deterministically regenerates English
            from the IR on the right
          </span>
        </div>
        <div className="inputs">
          <div className="input-panel">
            <div className="head">
              <span className="label">contract.md</span>
              <span>markdown input</span>
            </div>
            <pre className="body">{contract || "(contract.md not found)"}</pre>
          </div>
          <div className="input-panel">
            <div className="head">
              <span className="label">english.txt</span>
              <span>deterministic regeneration · no LLM</span>
            </div>
            <div className="english-body">{englishBlocks}</div>
          </div>
        </div>

        <details className="ir-drawer">
          <summary>
            <strong>Show intermediate representation</strong>
            {" — "}
            {(ir.clauses ?? []).length} clauses drive every scenario below
          </summary>
          <div className="ir-body">
            {(ir.clauses ?? []).map((c) => (
              <div
                key={c.id}
                className={`article ${linkClass(c.id)}`}
                {...linkHandlers(c.id)}
              >
                <div className="art-head">
                  <span className={`art-kind ${c.effect?.kind ?? "unmodeled"}`}>
                    {c.effect?.kind ?? "unmodeled"}
                  </span>
                  <span className="art-id">{c.id}</span>
                </div>
                <div className="art-title">{c.title ?? c.id}</div>
                <div className="art-body">
                  <ClauseBody c={c} />
                </div>
              </div>
            ))}
          </div>
        </details>
      </section>

      <section className="zone">
        <div className="zone-label">
          Step 2 · Pick a scenario for this contract
          <span className="hint">
            {" "}— scenarios are generated for the <strong>{meta.family}</strong> family; each exercises
            a distinct archetype
          </span>
        </div>
        <div className="scenarios">
          {meta.scenarios.map((s) => {
            const isSelected = s.archetype === selectedArchetype;
            return (
              <button
                key={s.archetype}
                type="button"
                className={`scenario-card${isSelected ? " selected" : ""}`}
                onClick={() => selectScenario(s.archetype)}
                aria-pressed={isSelected}
              >
                <div className="run-id">{s.archetype}</div>
                <div className="title">{s.label}</div>
                <div className="events">
                  <span>{s.scenarioId}</span>
                </div>
                <div className="foot">
                  <span className="bal">{fmtMoney(s.endingBalance, currency)}</span>
                  {s.breached ? (
                    <span className="breach-badge yes">breach</span>
                  ) : (
                    <span className="breach-badge no">clean</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="zone">
        <div className="zone-label">
          Step 3 · Run the contract
          <span className="hint">
            {" "}— apply the IR to the selected scenario; results are computed by the runtime (no LLM)
          </span>
        </div>

        {!runResultsVisible ? (
          <div className="execute-prompt">
            <button
              type="button"
              className="execute-button"
              onClick={runNow}
              disabled={!selectedArchetype || isRunning}
            >
              {isRunning ? "Running..." : "▶ Run"}{" "}
              <span className="mono">{selectedArchetype ?? ""}</span>{" "}
              against <span className="mono">{meta.contractId}</span>
            </button>
            <div className="hint" style={{ marginTop: 8 }}>
              {scenario ? (
                <>
                  Will replay {scenario.events?.length ?? 0} events and{" "}
                  {scenario.assumptions?.length ?? 0} assumptions through the runtime.
                </>
              ) : (
                <>Select a scenario above to enable this step.</>
              )}
            </div>
            {runError ? (
              <div className="hint" style={{ marginTop: 8, color: "#b42318" }}>
                {runError}
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <div className="exec-ribbon">
              <div className="exec-cell">
                <div className="k">Ending balance</div>
                <div className="v">{fmtMoney(summary.endingBalance, currency)}</div>
              </div>
              <div className="exec-cell">
                <div className="k">Total paid</div>
                <div className="v">{fmtMoney(summary.totalPaid, currency)}</div>
              </div>
              <div className="exec-cell">
                <div className="k">Interest charged</div>
                <div className="v">{fmtMoney(summary.totalInterestCharged, currency)}</div>
              </div>
              <div className="exec-cell">
                <div className="k">Fees charged</div>
                <div className="v">{fmtMoney(summary.totalFeesCharged, currency)}</div>
              </div>
              <div className="exec-cell">
                <div className="k">Breach</div>
                <div
                  className={
                    "v" +
                    (summary.breached === true
                      ? " breach-yes"
                      : summary.breached === false
                        ? " breach-no"
                        : "")
                  }
                >
                  {summary.breached === true
                    ? "yes"
                    : summary.breached === false
                      ? "none"
                      : "—"}
                </div>
              </div>
            </div>

            <div className="ledger">
              <div className="led-head">
                <div>Date</div>
                <div>Description</div>
                <div className="r">Amount</div>
                <div className="r">Balance</div>
              </div>
              <div>
                {(liveExecution?.ledger ?? []).map((ent: LedgerEntry) => {
                  const evMatch = /(evt-\d+)/.exec(ent.id ?? "");
                  const eventId = evMatch ? evMatch[1] : undefined;
                  const amtCls = ent.amount < 0 ? "neg" : "pos";
                  return (
                    <div
                      key={ent.id}
                      className={`led-row ${linkClass(ent.clauseId, eventId)}`}
                      {...linkHandlers(ent.clauseId, eventId)}
                    >
                      <span className="d">{fmtDate(ent.date)}</span>
                      <span>
                        <span className="k">{ent.kind}</span>{" "}
                        <span className="dsc">{ent.description ?? ""}</span>
                      </span>
                      <span className={`amt ${amtCls}`}>
                        {fmtMoney(ent.amount, currency)}
                      </span>
                      <span className="bal">
                        {fmtMoney(ent.balanceAfter, currency)}
                      </span>
                    </div>
                  );
                })}
                {(liveExecution?.ledger ?? []).length === 0 ? (
                  <div className="muted italic" style={{ padding: 12 }}>
                    (no ledger entries)
                  </div>
                ) : null}
              </div>
            </div>

            <div className="obls">
              {(liveExecution?.obligations ?? []).map((o: Obligation) => (
                <div
                  key={o.id}
                  className={`obl ${o.status && o.status !== "met" ? "breach" : ""} ${linkClass(o.clauseId)}`}
                  {...linkHandlers(o.clauseId)}
                >
                  <div>
                    <div className="o-title">Obligation · {o.clauseId}</div>
                    <div className="o-amt">
                      due {fmtMoney(o.amountDue, currency)} · paid{" "}
                      {fmtMoney(o.amountPaid, currency)} · by {fmtDate(o.dueDate)}
                    </div>
                  </div>
                  <div className="o-status">{o.status ?? "—"}</div>
                </div>
              ))}
              {(liveExecution?.breaches ?? []).map((b: Breach) => (
                <div
                  key={b.id}
                  className={`breach-note ${linkClass(b.clauseId)}`}
                  {...linkHandlers(b.clauseId)}
                >
                  <strong>Breach:</strong> {b.description}
                  <span className="meta">
                    on {fmtDate(b.date)} · {b.clauseId}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </main>
  );
}
