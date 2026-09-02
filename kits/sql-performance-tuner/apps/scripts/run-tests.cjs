const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { AGENT_CONTRACT_VERSION, strategistInputSchema } = require("../lib/contracts.ts");
const { DEMO_QUERY } = require("../lib/demo-database.ts");
const { chooseNextExperiment, normalizeReviewerOutput } = require("../lib/planner.ts");
const { selectWinningExperiment, tuneQuery, tuneQueryWithDependencies } = require("../lib/tuner.ts");

const benchmark = {
  warmupRuns: 1,
  measuredRuns: [10, 11, 10, 9, 10],
  medianMs: 10,
};

const result = {
  columns: ["customer_id", "revenue"],
  rowCount: 2,
  ordered: false,
  hash: "fixture-result-hash",
  exceededRowLimit: false,
};

const baseline = {
  query: DEMO_QUERY,
  plan: [{ id: 1, parentId: 0, detail: "SCAN orders" }],
  result,
  benchmark,
};

const schema = [{
  name: "orders",
  columns: [
    { name: "customer_id", declaredType: "INTEGER", nullable: false, primaryKeyPosition: 0 },
    { name: "created_at", declaredType: "TEXT", nullable: false, primaryKeyPosition: 0 },
    { name: "total", declaredType: "REAL", nullable: false, primaryKeyPosition: 0 },
    { name: "status", declaredType: "TEXT", nullable: false, primaryKeyPosition: 0 },
  ],
  indexes: [],
}];

const baseAdaptation = {
  learnedFromEvidence: "The prior evidence was considered.",
  differsFromPrevious: "This candidate changes the tested access path.",
};

function decision(overrides = {}) {
  return {
    contractVersion: AGENT_CONTRACT_VERSION,
    action: "create_index",
    strategy: "filter_first_index",
    hypothesis: "A filter-first index should reduce scanned rows.",
    expectedPlanChange: "SCAN orders -> SEARCH orders USING COVERING INDEX",
    indexSql: "CREATE INDEX idx_orders_created_customer_total ON orders(created_at, customer_id, total);",
    adaptation: {
      learnedFromEvidence: "No prior measured evidence was available.",
      differsFromPrevious: "This is the first proposed experiment.",
    },
    stopConditions: ["Stop if the candidate is unsafe, changes results, or is not at least 1.10x faster."],
    ...overrides,
  };
}

function reviewer() {
  return async (_mode, input) => ({
    contractVersion: AGENT_CONTRACT_VERSION,
    headline: input.deterministicOutcome === "improved" ? "Improvement proven" : "No measured improvement was proven",
    evidenceSummary: `${input.experiments.length} experiment(s) were evaluated.`,
    recommendation: input.winningExperimentNumber
      ? `Use experiment ${input.winningExperimentNumber}.`
      : "Keep the original query.",
    limitations: ["Validate against representative production data."],
    citedExperiments: input.experiments.map((experiment) => experiment.number),
  });
}

function plannerFrom(decisions) {
  let callCount = 0;
  return {
    get calls() {
      return callCount;
    },
    chooseNextExperiment: async (mode, input) => {
      callCount += 1;
      return decisions(input, callCount, mode);
    },
  };
}

async function main() {
  const firstInput = strategistInputSchema.parse({
    contractVersion: AGENT_CONTRACT_VERSION,
    originalQuery: DEMO_QUERY,
    schema,
    baseline,
    experiments: [],
    attemptedStrategies: [],
    remainingExperiments: 5,
  });
  const firstProposal = await chooseNextExperiment("demo", firstInput);
  assert.equal(firstProposal.action, "create_index", "No previous experiments should produce a safe first proposal.");
  assert.equal(firstProposal.strategy, "filter_first_index");
  assert.match(firstProposal.indexSql, /^CREATE INDEX/i);

  const exhausted = await chooseNextExperiment("demo", { ...firstInput, remainingExperiments: 0 });
  assert.equal(exhausted.action, "conclude", "Remaining budget 0 should conclude.");
  assert.equal(exhausted.conclusionCode, "budget_exhausted");

  const adaptivePlanner = plannerFrom((input, call) => {
    if (call === 1) {
      return decision({
        strategy: "grouping_first_index",
        indexSql: "CREATE INDEX idx_orders_customer_total ON orders(customer_id, total);",
      });
    }
    assert.equal(input.experiments[0]?.strategy, "grouping_first_index");
    assert.ok(input.experiments[0]?.observation, "Measured observation should be supplied to the next planner turn.");
    if (call === 2) {
      return decision({
        strategy: "filter_first_index",
        adaptation: {
          learnedFromEvidence: "The grouping-first candidate did not prove a win.",
          differsFromPrevious: "This puts the WHERE column before grouping and aggregate columns.",
          respondsToExperiment: 1,
        },
      });
    }
    return {
      contractVersion: AGENT_CONTRACT_VERSION,
      action: "conclude",
      strategy: "conclude",
      conclusionCode: "winner_found",
      reasoning: "Enough evidence was collected.",
      evidenceUsed: input.experiments.map((experiment) => experiment.number),
    };
  });
  const adaptiveReport = await tuneQueryWithDependencies(DEMO_QUERY, "demo", {
    chooseNextExperiment: adaptivePlanner.chooseNextExperiment,
    reviewTuningOutcome: reviewer(),
  });
  assert.equal(adaptiveReport.experiments[0]?.strategy, "grouping_first_index");
  assert.equal(adaptiveReport.experiments[1]?.strategy, "filter_first_index");
  assert.match(adaptiveReport.experiments[1]?.adaptation?.differsFromPrevious ?? "", /WHERE column|filter/i);

  const pivotPlanner = plannerFrom((input, call) => {
    if (call === 1) {
      return decision({
        strategy: "partial_index",
        indexSql: "CREATE INDEX idx_orders_partial ON orders(created_at) WHERE status = 'paid';",
      });
    }
    if (call === 2) {
      return decision({
        strategy: "grouping_first_index",
        indexSql: "CREATE INDEX idx_orders_unknown ON orders(not_a_column);",
        adaptation: baseAdaptation,
      });
    }
    if (call === 3) {
      return decision({
        action: "rewrite_query",
        strategy: "query_rewrite",
        sql: DEMO_QUERY,
        adaptation: {
          learnedFromEvidence: "Two index candidates were rejected by deterministic guards.",
          differsFromPrevious: "This changes query shape instead of adding another index.",
          respondsToExperiment: 2,
        },
      });
    }
    return {
      contractVersion: AGENT_CONTRACT_VERSION,
      action: "conclude",
      strategy: "conclude",
      conclusionCode: "no_safe_distinct_experiment",
      reasoning: "Stop after the rewrite attempt.",
      evidenceUsed: input.experiments.map((experiment) => experiment.number),
    };
  });
  const pivotReport = await tuneQueryWithDependencies(DEMO_QUERY, "demo", {
    chooseNextExperiment: pivotPlanner.chooseNextExperiment,
    reviewTuningOutcome: reviewer(),
  });
  assert.equal(pivotReport.experiments[0]?.verdict, "guard-rejected", "Unsafe SQL should be guard-rejected.");
  assert.equal(pivotReport.experiments[1]?.verdict, "guard-rejected");
  assert.equal(pivotReport.experiments[2]?.kind, "rewrite_query", "Two unsuccessful indexes should lead to a rewrite, revision, or conclusion.");

  const duplicatePlanner = plannerFrom((_input, call) => {
    if (call === 1) {
      return decision({
        indexSql: "CREATE INDEX idx_orders_a ON orders(created_at, customer_id, total);",
      });
    }
    return decision({
      indexSql: "CREATE INDEX idx_orders_b ON orders(total, customer_id, created_at);",
      adaptation: {
        learnedFromEvidence: "The prior index was already tested.",
        differsFromPrevious: "Only the column order changed.",
        respondsToExperiment: 1,
      },
    });
  });
  const duplicateReport = await tuneQueryWithDependencies(DEMO_QUERY, "demo", {
    chooseNextExperiment: duplicatePlanner.chooseNextExperiment,
    reviewTuningOutcome: reviewer(),
  });
  assert.equal(duplicatePlanner.calls, 2);
  assert.equal(duplicateReport.experiments.length, 1, "Duplicate SQL or equivalent index ordering should not execute twice.");

  const nonEquivalentPlanner = plannerFrom((_input, call) => call === 1
    ? decision({
      action: "rewrite_query",
      strategy: "query_rewrite",
      sql: "SELECT customer_id FROM orders WHERE created_at >= '2026-01-01'",
    })
    : {
      contractVersion: AGENT_CONTRACT_VERSION,
      action: "conclude",
      strategy: "conclude",
      conclusionCode: "no_safe_distinct_experiment",
      reasoning: "The rewrite changed result shape.",
      evidenceUsed: [1],
    });
  const nonEquivalentReport = await tuneQueryWithDependencies(DEMO_QUERY, "demo", {
    chooseNextExperiment: nonEquivalentPlanner.chooseNextExperiment,
    reviewTuningOutcome: reviewer(),
  });
  assert.equal(nonEquivalentReport.experiments[0]?.verdict, "non-equivalent", "Non-equivalent rewrites should be rejected.");

  const belowThreshold = {
    number: 1,
    kind: "create_index",
    strategy: "filter_first_index",
    hypothesis: "Synthetic near-improvement.",
    candidateSql: "CREATE INDEX idx_orders_created_at ON orders(created_at);",
    expectedPlanChange: "SEARCH orders USING INDEX",
    verdict: "improved",
    failureClass: "none",
    summary: "Synthetic fixture.",
    observation: "Measured only 1.09x faster.",
    equivalence: true,
    speedup: 1.09,
  };
  assert.equal(selectWinningExperiment([belowThreshold]), undefined, "Improvements below 1.10x should not be winners.");

  const reviewInput = {
    contractVersion: AGENT_CONTRACT_VERSION,
    originalQuery: DEMO_QUERY,
    baseline,
    experiments: [],
    deterministicOutcome: "no-proven-improvement",
  };
  assert.throws(
    () => normalizeReviewerOutput({
      outcome: "improved",
      headline: "Use it",
      evidenceSummary: "Contradiction.",
      recommendation: "Use a candidate.",
      limitationsText: "Fixture.",
      citedExperimentsCsv: "1",
    }, reviewInput),
    /contradicted/,
    "Reviewer cannot contradict deterministic outcome.",
  );
  assert.deepEqual(
    normalizeReviewerOutput({
      outcome: "no_proven_improvement",
      headline: "No measured improvement was proven",
      evidenceSummary: "No winner.",
      recommendation: "Keep the original query.",
      limitationsText: "Fixture.",
      citedExperimentsCsv: 1,
    }, reviewInput).citedExperiments,
    [1],
    "Reviewer CSV fields should normalize numeric values.",
  );
  assert.deepEqual(
    normalizeReviewerOutput({
      outcome: "no_proven_improvement",
      headline: "No measured improvement was proven",
      evidenceSummary: "No winner.",
      recommendation: "Keep the original query.",
      limitationsText: "Fixture.",
      citedExperimentsCsv: "1, 2, 2, nope",
    }, reviewInput).citedExperiments,
    [1, 2],
    "Reviewer CSV fields should normalize string values.",
  );

  const demoReport = await tuneQuery(DEMO_QUERY, "demo");
  assert.ok(demoReport.review, "Demo tuning should return reviewer output.");
  assert.ok(demoReport.review.recommendation.length > 0);

  let invoked = false;
  const invalidReport = await tuneQueryWithDependencies("DROP TABLE orders", "live", {
    chooseNextExperiment: async () => {
      invoked = true;
      throw new Error("Planner should not run for invalid input.");
    },
    reviewTuningOutcome: reviewer(),
  });
  assert.equal(invalidReport.status, "invalid-input");
  assert.equal(invoked, false, "Invalid input should be handled without invoking Lamatic.");

  console.log("SQL tuner tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
