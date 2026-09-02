import assert from "node:assert/strict";

import {
  AGENT_CONTRACT_VERSION,
  reviewerInputSchema,
  reviewerOutputSchema,
  strategistDecisionSchema,
  strategistInputSchema,
} from "../lib/contracts.ts";

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
  query: "SELECT customer_id, SUM(total) AS revenue FROM orders GROUP BY customer_id",
  plan: [{ id: 1, parentId: 0, detail: "SCAN orders" }],
  result,
  benchmark,
};

const schema = [{
  name: "orders",
  columns: [
    { name: "customer_id", declaredType: "INTEGER", nullable: false, primaryKeyPosition: 0 },
    { name: "total", declaredType: "REAL", nullable: false, primaryKeyPosition: 0 },
  ],
  indexes: [],
}];

const experiment = {
  number: 1,
  kind: "create_index",
  strategy: "covering_index",
  hypothesis: "A covering index may avoid table reads.",
  candidateSql: "CREATE INDEX idx_orders_customer_total ON orders(customer_id, total);",
  expectedPlanChange: "SCAN orders -> SCAN orders USING COVERING INDEX",
  verdict: "slower",
  summary: "Equivalent results, but the measured candidate was slower.",
  plan: [{ id: 1, parentId: 0, detail: "SCAN orders USING COVERING INDEX" }],
  result,
  benchmark: { ...benchmark, medianMs: 12 },
  equivalence: true,
  speedup: 0.83,
  failureClass: "performance",
  observation: "The covering index preserved results but increased median runtime.",
};

const validStrategistInput = {
  contractVersion: AGENT_CONTRACT_VERSION,
  originalQuery: baseline.query,
  schema,
  baseline,
  experiments: [experiment],
  attemptedStrategies: ["covering_index"],
  remainingExperiments: 4,
};

assert.equal(strategistInputSchema.safeParse(validStrategistInput).success, true);

const invalidBudget = strategistInputSchema.safeParse({
  ...validStrategistInput,
  remainingExperiments: 5,
});
assert.equal(invalidBudget.success, false, "Inconsistent experiment budgets must be rejected.");

const invalidHistory = strategistInputSchema.safeParse({
  ...validStrategistInput,
  attemptedStrategies: ["query_rewrite"],
});
assert.equal(invalidHistory.success, false, "Strategy history must match measured evidence.");

const pivotDecision = {
  contractVersion: AGENT_CONTRACT_VERSION,
  action: "rewrite_query",
  strategy: "query_rewrite",
  hypothesis: "A pre-aggregation rewrite may reduce temporary grouping work.",
  expectedPlanChange: "Remove temporary B-tree use.",
  sql: baseline.query,
  adaptation: {
    learnedFromEvidence: "The covering index was slower on this dataset.",
    differsFromPrevious: "This tests query shape instead of another index.",
    respondsToExperiment: 1,
  },
  stopConditions: ["Stop if the rewrite changes results or is not at least 1.10x faster."],
};
assert.equal(strategistDecisionSchema.safeParse(pivotDecision).success, true);

const contradictoryReview = reviewerInputSchema.safeParse({
  contractVersion: AGENT_CONTRACT_VERSION,
  originalQuery: baseline.query,
  baseline,
  experiments: [experiment],
  deterministicOutcome: "improved",
  winningExperimentNumber: 1,
});
assert.equal(
  contradictoryReview.success,
  false,
  "The reviewer must not promote a slower experiment to winner.",
);

const validReviewInput = {
  contractVersion: AGENT_CONTRACT_VERSION,
  originalQuery: baseline.query,
  baseline,
  experiments: [experiment],
  deterministicOutcome: "no-proven-improvement",
};
assert.equal(reviewerInputSchema.safeParse(validReviewInput).success, true);

assert.equal(reviewerOutputSchema.safeParse({
  contractVersion: AGENT_CONTRACT_VERSION,
  headline: "No measured improvement was proven",
  evidenceSummary: "Experiment 1 preserved results but was slower than the baseline.",
  recommendation: "Keep the original query and collect a representative workload before retrying.",
  limitations: ["The benchmark used the supplied SQLite snapshot."],
  citedExperiments: [1],
}).success, true);

console.log("Agent contract checks passed.");
