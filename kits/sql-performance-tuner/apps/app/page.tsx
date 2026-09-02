"use client";

import {
  Activity, Check, ChevronRight, CircleAlert, Clock3, Database,
  Gauge, Play, RotateCcw, ShieldCheck, Sparkles, Upload,
} from "lucide-react";
import { useState } from "react";

import type { RunMode, StrategistExperimentEvidence, TuningReport } from "../lib/contracts";
import { DEMO_QUERY } from "../lib/demo-database";

function milliseconds(value?: number): string {
  if (value === undefined) return "-";
  return `${value.toFixed(value < 10 ? 2 : 1)} ms`;
}

function verdictLabel(verdict: StrategistExperimentEvidence["verdict"]): string {
  return {
    improved: "Proven faster",
    slower: "Slower",
    "equivalent-noise": "No clear gain",
    "guard-rejected": "Guard rejected",
    "non-equivalent": "Results changed",
    "execution-failed": "Execution failed",
  }[verdict];
}

function strategyLabel(strategy: StrategistExperimentEvidence["strategy"]): string {
  return {
    covering_index: "Covering index",
    filter_first_index: "Filter-first index",
    grouping_first_index: "Grouping-first index",
    partial_index: "Partial index",
    query_rewrite: "Query rewrite",
    revise_failed_candidate: "Revision",
  }[strategy];
}

function recommendationSql(report: TuningReport): string {
  return report.winner?.candidateSql ?? report.originalQuery;
}

function Experiment({ experiment, winner }: { experiment: StrategistExperimentEvidence; winner: boolean }) {
  const planDetails = experiment.plan?.map((step) => step.detail).filter(Boolean) ?? [];
  return (
    <article className={`experiment ${winner ? "experiment-winner" : ""}`}>
      <div className="experiment-head">
        <div className="experiment-index">{experiment.number}</div>
        <div>
          <p className="eyebrow">Lamatic strategist · {strategyLabel(experiment.strategy)}</p>
          <h3>{experiment.hypothesis}</h3>
        </div>
        <span className={`verdict verdict-${experiment.verdict}`}>{verdictLabel(experiment.verdict)}</span>
      </div>
      {experiment.adaptation ? (
        <div className="strategy-note">
          <span>Strategy</span>
          <p>{experiment.adaptation.learnedFromEvidence}</p>
          <p>{experiment.adaptation.differsFromPrevious}</p>
        </div>
      ) : null}
      <pre className="sql-block"><code>{experiment.candidateSql}</code></pre>
      <div className="experiment-metrics">
        <span><ShieldCheck size={15} /> {experiment.equivalence ? "Same results" : "Not verified"}</span>
        <span><Clock3 size={15} /> {milliseconds(experiment.benchmark?.medianMs)}</span>
        <span><Gauge size={15} /> {experiment.speedup ? `${experiment.speedup.toFixed(2)}x` : "-"}</span>
      </div>
      <div className="local-observation">
        <span>Deterministic local measurement</span>
        <p>{experiment.observation}</p>
      </div>
      <p className="experiment-summary">{experiment.summary}</p>
      {planDetails.length ? (
        <div className="plan-line"><ChevronRight size={15} /><code>{planDetails.join(" · ")}</code></div>
      ) : null}
    </article>
  );
}

export default function HomePage() {
  const [query, setQuery] = useState(DEMO_QUERY);
  const [mode, setMode] = useState<RunMode>("demo");
  const [report, setReport] = useState<TuningReport | null>(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [databaseFile, setDatabaseFile] = useState<{ name: string; base64: string; size: number } | null>(null);

  async function selectDatabase(file?: File) {
    if (!file) return;
    setError("");
    if (file.size > 4 * 1024 * 1024) {
      setError("SQLite uploads are limited to 4 MB.");
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    setDatabaseFile({ name: file.name, base64: window.btoa(binary), size: file.size });
    setReport(null);
  }

  async function runTuner() {
    setRunning(true);
    setError("");
    setReport(null);
    try {
      const response = await fetch("/api/tune", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, mode, databaseBase64: databaseFile?.base64 }),
      });
      const payload = (await response.json()) as TuningReport;
      if (!response.ok) throw new Error(payload.conclusion || "The tuning run failed.");
      setReport(payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The tuning run failed.");
    } finally {
      setRunning(false);
    }
  }

  function resetDemo() {
    setQuery(DEMO_QUERY);
    setReport(null);
    setError("");
    setDatabaseFile(null);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark"><Activity size={19} /></div>
        <div className="brand-copy"><strong>SQL Performance Tuner</strong><span>SQLite experiment agent</span></div>
        <div className="runtime-status"><span /> Bounded sandbox</div>
      </header>

      <section className="workspace">
        <div className="editor-pane">
          <div className="section-heading">
            <div><p className="eyebrow">Input</p><h1>Query workspace</h1></div>
            <button className="icon-button" type="button" title="Reset demo query" onClick={resetDemo}><RotateCcw size={17} /></button>
          </div>

          <div className="source-row">
            <label className="source-chip" title="Choose a SQLite database up to 4 MB">
              <Database size={16} />
              <span className="source-name">{databaseFile?.name ?? "commerce-demo.sqlite"}</span>
              <span>{databaseFile ? `${(databaseFile.size / 1024).toFixed(0)} KB` : "32k orders"}</span>
              <Upload size={14} />
              <input aria-label="Choose SQLite database" type="file" accept=".db,.sqlite,.sqlite3,application/vnd.sqlite3" onChange={(event) => selectDatabase(event.target.files?.[0])} />
            </label>
            <div className="mode-control" aria-label="Planner mode">
              <button className={mode === "demo" ? "active" : ""} onClick={() => setMode("demo")}>Demo planner</button>
              <button className={mode === "live" ? "active" : ""} onClick={() => setMode("live")}><Sparkles size={14} /> Live Lamatic</button>
            </div>
          </div>

          <label className="query-label" htmlFor="query">Read-only SQL</label>
          <div className="editor-wrap">
            <div className="line-number">1</div>
            <textarea id="query" value={query} onChange={(event) => setQuery(event.target.value)} spellCheck={false} aria-label="SQL query" />
          </div>

          <div className="editor-footer">
            <div className="guard-list">
              <span><Check size={14} /> SELECT / WITH only</span>
              <span><Check size={14} /> Five experiments max</span>
              <span><Check size={14} /> Full result comparison</span>
            </div>
            <button className="run-button" type="button" onClick={runTuner} disabled={running || !query.trim()}>
              {running ? <span className="spinner" /> : <Play size={17} fill="currentColor" />}
              {running ? "Running experiments" : "Run tuner"}
            </button>
          </div>
        </div>

        <aside className="summary-pane">
          <div className="section-heading">
            <div><p className="eyebrow">Run summary</p><h2>{report ? (report.status === "improved" ? "Improvement proven" : "Run complete") : "Awaiting run"}</h2></div>
            {report?.status === "improved" ? <div className="success-icon"><Check size={18} /></div> : null}
          </div>

          {!report && !error ? <div className="empty-state"><Gauge size={30} /><p>Run the query to measure its baseline and test bounded optimization experiments.</p></div> : null}
          {error ? <div className="error-state"><CircleAlert size={20} /><p>{error}</p></div> : null}

          {report?.baseline ? (
            <>
              <div className="headline-metric"><span>Best measured speedup</span><strong>{report.winner?.speedup ? `${report.winner.speedup.toFixed(2)}x` : "None"}</strong></div>
              <div className="metric-grid">
                <div><span>Baseline median</span><strong>{milliseconds(report.baseline.benchmark.medianMs)}</strong></div>
                <div><span>Candidate median</span><strong>{milliseconds(report.winner?.benchmark?.medianMs)}</strong></div>
                <div><span>Result rows</span><strong>{report.baseline.result.rowCount.toLocaleString()}</strong></div>
                <div><span>Experiments</span><strong>{report.experiments.length} / 5</strong></div>
              </div>
              <div className="baseline-plan"><span>Baseline plan</span><code>{report.baseline.plan.map((step) => step.detail).filter(Boolean).join(" · ") || "No plan details returned"}</code></div>
              <p className="conclusion">{report.conclusion}</p>
            </>
          ) : null}
        </aside>
      </section>

      {report ? (
        <section className="results-band">
          <div className="results-inner">
            <div className="results-title"><div><p className="eyebrow">Evidence trail</p><h2>Experiments</h2></div><span>{report.experiments.length} evaluated</span></div>
            {report.experiments.length ? (
              <div className="experiment-list">{report.experiments.map((experiment) => <Experiment key={experiment.number} experiment={experiment} winner={report.winner?.number === experiment.number} />)}</div>
            ) : <p className="no-experiments">The planner concluded without proposing a candidate.</p>}
            {report.review ? (
              <section className="review-panel" aria-labelledby="review-heading">
                <div className="review-copy">
                  <p className="eyebrow">Lamatic reviewer explanation</p>
                  <h2 id="review-heading">{report.review.headline}</h2>
                  <p>{report.review.evidenceSummary}</p>
                </div>
                <div className="recommendation-block">
                  <span>{report.winner ? "Recommended candidate" : "Recommendation"}</span>
                  <p>{report.review.recommendation}</p>
                  <pre className="sql-block"><code>{recommendationSql(report)}</code></pre>
                </div>
                <div className="review-meta">
                  <div>
                    <span>Reviewer cited</span>
                    <strong>{report.review.citedExperiments.length ? report.review.citedExperiments.map((number) => `#${number}`).join(", ") : "No experiment numbers"}</strong>
                  </div>
                  <div>
                    <span>Limitations</span>
                    <p>{report.review.limitations.length ? report.review.limitations.join(" ") : "No additional reviewer limitations returned."}</p>
                  </div>
                </div>
              </section>
            ) : null}
            {report.caveats.length ? <div className="caveats"><CircleAlert size={17} /><p>{report.caveats.join(" ")}</p></div> : null}
          </div>
        </section>
      ) : null}
    </main>
  );
}
