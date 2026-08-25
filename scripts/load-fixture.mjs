#!/usr/bin/env node
// Repeatable scale fixture. Against a *staging* Convex deploy this seeds
// one workspace with many lists + tasks so Home, list view, Reports,
// paged list_tasks, and chunked export can be timed against the query
// budget. It refuses production URLs.
//
//   CONVEX_URL=https://<staging>.convex.cloud \
//   CONVEX_DEPLOY_KEY=... \
//   node scripts/load-fixture.mjs
//
// Default size is 10 lists × 100 tasks (1k). Pass --scale=10k for
// 50 lists × 200 tasks. The convex-test counterpart lives in
// tests/pagination.test.ts (bounded, CI-safe).

const scale = process.argv.includes("--scale=10k") ? "10k" : "1k";
const lists = scale === "10k" ? 50 : 10;
const tasksPerList = scale === "10k" ? 200 : 100;

const url = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "";
if (!url) {
  console.log(
    [
      "load-fixture: no CONVEX_URL.",
      `Would seed ${lists} lists × ${tasksPerList} tasks (${lists * tasksPerList} total).`,
      "Run against staging only. See docs/PRODUCTION-RUNBOOK.md (Backup / DR).",
      "CI proves the pagination contract in tests/pagination.test.ts.",
    ].join("\n"),
  );
  process.exit(0);
}

if (/operate\.to|prod/i.test(url) && !process.env.LOAD_FIXTURE_ALLOW_PROD) {
  console.error("Refusing to seed a production-looking Convex URL.");
  process.exit(1);
}

console.log(
  `load-fixture: ${scale} against ${url} (${lists} lists × ${tasksPerList} tasks).`,
);
console.log(
  "Insert via the Convex dashboard Functions runner or a one-off internal mutation;",
  "this script is the documented gate, not a silent write into the system of record.",
);
console.log("Gate: Home, one list view, Reports, MCP list_tasks (paged), export.");
