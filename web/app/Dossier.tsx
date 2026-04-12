"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import type {
  IR, Scenario, RunResult, Clause, Expr, LedgerEntry, Obligation, Breach,
} from "./lib/types";
import type { RunSummary } from "./page";

interface Props {
  summaries: RunSummary[];
  selected: string;
  ir: IR;
  scenario: Scenario | null;
  runResult: RunResult | null;
  english: string;
  contract: string;
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
    const dt = new Date(d + "T00:00:00");
    return dt.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
  } catch { return d; }
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
  if (c.kind === "formula" && c.outputVar) {
    return (
      <div>
        computes <span className="mono">{c.outputVar}</span>{" = "}
        <span className="mono">{renderExpr(c.expr)}</span>
      </div>
    );
  }
  if (c.kind === "fee") {
    return (
      <div>
        {c.feeType ?? "fee"} · <span className="mono">{fmtMoney(c.amountValue)}</span>
        {c.triggerDescription ? <> · when {c.triggerDescription}</> : null}
      </div>
    );
  }
  if (c.kind === "obligation") {
    return (
      <div>
        {c.actor ?? "party"} must {c.action ?? "perform duty"}
        {c.due?.value ? <> ({c.due?.type ?? "due"}: <span className="mono">{c.due.value}</span>)</> : null}
      </div>
    );
  }
  if (c.kind === "default") {
    return (
      <>
        <div>when {c.triggerDescription ?? "triggered"}</div>
        {c.consequences?.length ? (
          <div style={{ marginTop: 4 }}>
            Consequences: {c.consequences.join("; ")}
          </div>
        ) : null}
      </>
    );
  }
  return <div style={{ color: "var(--muted)", fontStyle: "italic" }}>{c.title ?? ""}</div>;
}

function ScenarioCard({
  s, selected, onSelect,
}: {
  s: RunSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`scenario-card${selected ? " selected" : ""}`}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <div className="run-id">{s.run}</div>
      <div className="title">{s.title}</div>
      <div className="events">
        {s.firstEvents.length === 0 ? (
          <span>(no events)</span>
        ) : (
          s.firstEvents.map((e, i) => (
            <span key={i}>
              {fmtDate(e.date) || "—"} · {e.type.replace(/_/g, " ")}
            </span>
          ))
        )}
        {s.eventCount > s.firstEvents.length ? (
          <span>+ {s.eventCount - s.firstEvents.length} more</span>
        ) : null}
      </div>
      <div className="foot">
        <span className="bal">{fmtMoney(s.endingBalance)}</span>
        {s.breached === true ? (
          <span className="breach-badge yes">breach</span>
        ) : s.breached === false ? (
          <span className="breach-badge no">clean</span>
        ) : (
          <span className="breach-badge">—</span>
        )}
      </div>
    </button>
  );
}

export default function Dossier({
  summaries, selected, ir, scenario, runResult, english, contract,
}: Props) {
  const router = useRouter();
  const [hover, setHover] = useState<Link>({});
  const [locked, setLocked] = useState<Link>({});

  useEffect(() => {
    const clear = () => setLocked({});
    document.addEventListener("click", clear);
    return () => document.removeEventListener("click", clear);
  }, []);

  const linkClass = useCallback((clauseId?: string, eventId?: string) => {
    const classes: string[] = [];
    const matchesHover =
      (clauseId && hover.clauseId === clauseId) ||
      (eventId  && hover.eventId  === eventId);
    const matchesLock =
      (clauseId && locked.clauseId === clauseId) ||
      (eventId  && locked.eventId  === eventId);
    if (matchesHover) classes.push(eventId && !clauseId ? "event-hover" : "linked-hover");
    if (matchesLock)  classes.push("locked");
    return classes.join(" ");
  }, [hover, locked]);

  const linkHandlers = useCallback((clauseId?: string, eventId?: string) => ({
    onMouseEnter: () => setHover({ clauseId, eventId }),
    onMouseLeave: () => setHover({}),
    onClick: (evt: React.MouseEvent) => {
      evt.stopPropagation();
      setLocked(prev =>
        prev.clauseId === clauseId && prev.eventId === eventId
          ? {}
          : { clauseId, eventId }
      );
    },
  }), []);

  const summary = runResult?.summary ?? {};
  const currency = ir.currency ?? "USD";

  const englishBlocks = useMemo(() => {
    return english.split("\n").map((raw, i) => {
      if (!raw.trim()) {
        return <span key={i} style={{ display: "block", height: 8 }} />;
      }
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
            <span className="cid">{cid}</span>{" — "}{m[2]}
          </span>
        );
      }
      const headMatch = /^(Parties:|Definitions:|Executable Clauses:|Modeled coverage.*)$/.exec(raw.trim());
      if (headMatch) {
        return <span key={i} className="line head">{raw.trim()}</span>;
      }
      const isMeta = /^(Contract|Contract ID|Currency)/.test(raw);
      return <span key={i} className={`line${isMeta ? " meta" : ""}`}>{raw}</span>;
    });
  }, [english, linkClass, linkHandlers]);

  const selectScenario = (run: string) => {
    if (run !== selected) router.push(`/?run=${encodeURIComponent(run)}`);
  };

  return (
    <main className="sheet">
      <header className="topbar">
        <div>
          <div className="brand">Executable Contracts · pipeline viewer</div>
          <h1>{ir.title ?? "Untitled Contract"}</h1>
        </div>
        <div className="meta">
          <div>run: <strong>{selected}</strong></div>
          <div>
            {ir.parties?.map(p => p.name).slice(0, 2).join(" ↔ ") || "—"}
            {" · "}{currency}
            {ir.metadata ? <> · {ir.metadata.modeledClauseCount ?? 0}/{ir.metadata.clauseCount ?? 0} modeled</> : null}
          </div>
        </div>
      </header>

      <section className="zone">
        <div className="zone-label">
          Inputs <span className="hint">— the round-trip anchors; identical regardless of scenario</span>
        </div>
        <div className="inputs">
          <div className="input-panel">
            <div className="head">
              <span className="label">contract.md</span>
              <span>markdown input</span>
            </div>
            <pre className="body">{contract || "(contract.md not found for this run)"}</pre>
          </div>
          <div className="input-panel">
            <div className="head">
              <span className="label">english.txt</span>
              <span>deterministic regeneration · no LLM</span>
            </div>
            <div className="english-body">{englishBlocks}</div>
          </div>
        </div>
      </section>

      <section className="zone">
        <div className="zone-label">
          Scenario <span className="hint">— the variable input; pick one to see how the IR reacts</span>
        </div>
        <div className="scenarios">
          {summaries.map(s => (
            <ScenarioCard
              key={s.run}
              s={s}
              selected={s.run === selected}
              onSelect={() => selectScenario(s.run)}
            />
          ))}
        </div>
      </section>

      <section className="zone">
        <div className="zone-label">
          Execution <span className="hint">— what the IR computes for the selected scenario</span>
        </div>
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
            <div className={
              "v" + (summary.breached === true ? " breach-yes" : summary.breached === false ? " breach-no" : "")
            }>
              {summary.breached === true ? "yes" : summary.breached === false ? "none" : "—"}
            </div>
          </div>
        </div>

        {runResult ? (
          <>
            <div className="ledger">
              <div className="led-head">
                <div>Date</div>
                <div>Description</div>
                <div className="r">Amount</div>
                <div className="r">Balance</div>
              </div>
              <div>
                {(runResult.ledger ?? []).map((ent: LedgerEntry) => {
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
                      <span className={`amt ${amtCls}`}>{fmtMoney(ent.amount, currency)}</span>
                      <span className="bal">{fmtMoney(ent.balanceAfter, currency)}</span>
                    </div>
                  );
                })}
                {(runResult.ledger ?? []).length === 0 ? (
                  <div style={{ padding: 12, color: "var(--muted)", fontStyle: "italic" }}>
                    (no ledger entries)
                  </div>
                ) : null}
              </div>
            </div>
            <div className="obls">
              {(runResult.obligations ?? []).map((o: Obligation) => (
                <div
                  key={o.id}
                  className={`obl ${o.status && o.status !== "met" ? "breach" : ""} ${linkClass(o.clauseId)}`}
                  {...linkHandlers(o.clauseId)}
                >
                  <div>
                    <div className="o-title">Obligation · {o.clauseId}</div>
                    <div className="o-amt">
                      due {fmtMoney(o.amountDue, currency)} · paid {fmtMoney(o.amountPaid, currency)} · by {fmtDate(o.dueDate)}
                    </div>
                  </div>
                  <div className="o-status">{o.status ?? "—"}</div>
                </div>
              ))}
              {(runResult.breaches ?? []).map((b: Breach) => (
                <div
                  key={b.id}
                  className={`breach-note ${linkClass(b.clauseId)}`}
                  {...linkHandlers(b.clauseId)}
                >
                  <strong>Breach:</strong> {b.description}
                  <span className="meta">on {fmtDate(b.date)} · {b.clauseId}</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div style={{ padding: 14, color: "var(--muted)", fontStyle: "italic" }}>
            execution.json not present
          </div>
        )}
      </section>

      <details className="ir-drawer zone">
        <summary>
          <strong>Show representation</strong> — the IR that drives every scenario ({(ir.clauses ?? []).length} clauses)
        </summary>
        <div className="ir-body">
          {(ir.clauses ?? []).map(c => (
            <div
              key={c.id}
              className={`article ${linkClass(c.id)}`}
              {...linkHandlers(c.id)}
            >
              <div className="art-head">
                <span className={`art-kind ${c.kind}`}>{c.kind}</span>
                <span className="art-id">{c.id}</span>
              </div>
              <div className="art-title">{c.title ?? c.id}</div>
              <div className="art-body"><ClauseBody c={c} /></div>
            </div>
          ))}
          {scenario ? (
            <div style={{ padding: 12, borderTop: "1px solid var(--rule)", fontSize: 12, color: "var(--muted)" }}>
              <strong style={{ color: "var(--ink)" }}>Scenario events:</strong>{" "}
              {(scenario.events ?? []).length} events ·{" "}
              {(scenario.assumptions ?? []).length} assumptions
            </div>
          ) : null}
        </div>
      </details>
    </main>
  );
}
