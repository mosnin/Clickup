// Sprint templates: the in-code catalog of sprint *shapes*. Where
// `templates.ts` seeds a list (statuses, fields, sample rows), a sprint
// template seeds a timebox — the goal statement, the ceremony cadence, and
// the starter work a sprint of that kind always needs. Applying one creates
// a real sprint plus real tasks attached to it, so the plan is executable
// from minute one instead of being a document someone has to translate.
//
// Kept as code (not data) for the same reason as list templates and
// built-in skills: templates ship with the app, are reviewable in a PR, and
// need no CMS. Add a template by appending to SPRINT_TEMPLATES.

export type SprintTemplatePriority = "urgent" | "high" | "normal" | "low";

export type SprintTemplateComplexity =
  | "beginner"
  | "intermediate"
  | "advanced";

export type SprintCeremony = {
  title: string;
  description?: string;
  /** Days after the sprint start. 0 = day one, 1 = day two, … */
  dayOffset: number;
  /** Rough cost of running it, in the same points currency as the work. */
  estimatePoints?: number;
  /** Ceremonies that repeat inside the timebox (standups, weekly reviews). */
  recurrence?: "daily" | "weekly";
};

export type SprintStarterTask = {
  title: string;
  description?: string;
  priority?: SprintTemplatePriority;
  estimatePoints?: number;
  /** Days after the sprint start this should land. Defaults to the last day. */
  dueDayOffset?: number;
  /** Acceptance criteria — materialized as the task's checklist. */
  checklist: string[];
};

export type SprintTemplate = {
  slug: string;
  name: string;
  /** One honest sentence: what this sprint is for, and what it isn't. */
  description: string;
  category: string;
  /** Free-text facets for filtering ("scrum", "launch", "quality", …). */
  useCases: string[];
  complexity: SprintTemplateComplexity;
  /** Typical timebox, in days. Drives the sprint end date. */
  lengthDays: number;
  /** Sprint goal, with obvious <placeholders> for the team to fill in. */
  goalTemplate: string;
  capacityPoints?: number;
  ceremonies: SprintCeremony[];
  starterTasks: SprintStarterTask[];
};

// The standard scrum cadence, sized to the timebox. Templates that run a
// different rhythm (design sprints, incident follow-ups, hackathons)
// declare their own ceremonies instead of calling this.
function scrumCadence(lengthDays: number): SprintCeremony[] {
  const mid = Math.max(1, Math.floor(lengthDays / 2));
  const last = Math.max(1, lengthDays - 1);
  return [
    {
      title: "Sprint planning",
      description:
        "Agree the goal, pull work in until capacity is full, and leave ~20% slack for what arrives mid-sprint. Nothing enters the sprint without an owner.",
      dayOffset: 0,
      estimatePoints: 2,
    },
    {
      title: "Daily standup",
      description:
        "Three lines per person or agent: shipped, in flight, blocked. Blockers get an owner in the room, not a follow-up meeting.",
      dayOffset: 1,
      estimatePoints: 1,
      recurrence: "daily",
    },
    {
      title: "Mid-sprint review",
      description:
        "Halfway checkpoint against the burndown. If the goal is at risk, cut scope here — not on the last day.",
      dayOffset: mid,
      estimatePoints: 1,
    },
    {
      title: "Sprint demo",
      description:
        "Show the working result to whoever asked for it. Demo the software, not the slides.",
      dayOffset: last,
      estimatePoints: 2,
    },
    {
      title: "Retrospective",
      description:
        "What worked, what didn't, one change to try next sprint. Record it on the sprint's retrospective field.",
      dayOffset: last,
      estimatePoints: 1,
    },
  ];
}

export const SPRINT_TEMPLATES: SprintTemplate[] = [
  // ── Product ──────────────────────────────────────────────────────────
  {
    slug: "two-week-product-sprint",
    name: "Two-week product sprint",
    description:
      "The default scrum timebox: one goal, a committed backlog, and a demo at the end.",
    category: "Product",
    useCases: ["scrum", "delivery", "cross-functional", "default"],
    complexity: "beginner",
    lengthDays: 14,
    goalTemplate:
      "Ship <capability> to <audience> so they can <outcome>, measured by <metric>.",
    capacityPoints: 40,
    ceremonies: scrumCadence(14),
    starterTasks: [
      {
        title: "Write the sprint goal and commit the backlog",
        description:
          "One sentence everyone can repeat. Every committed task should visibly serve it; anything that doesn't goes back to the backlog.",
        priority: "high",
        estimatePoints: 2,
        dueDayOffset: 0,
        checklist: [
          "Goal is a single sentence with a measurable outcome",
          "Every committed task has an owner and an estimate",
          "Committed points are at or under team capacity",
          "Goal posted in the workspace chat",
        ],
      },
      {
        title: "Break the largest story into shippable slices",
        description:
          "Anything estimated above a third of sprint capacity is a bet, not a task. Slice it until each piece can land on its own.",
        priority: "high",
        estimatePoints: 3,
        dueDayOffset: 1,
        checklist: [
          "No committed task exceeds 5 points",
          "Each slice is independently demoable",
          "Dependencies between slices recorded as blockers",
        ],
      },
      {
        title: "Confirm designs and acceptance criteria are ready",
        estimatePoints: 2,
        dueDayOffset: 1,
        checklist: [
          "Designs linked on every UI task",
          "Acceptance criteria written as a checklist per task",
          "Open questions raised with the requester",
        ],
      },
      {
        title: "Set up the demo environment",
        description:
          "Whatever the team shows on the last day should be reachable from day two, not assembled the night before.",
        estimatePoints: 2,
        dueDayOffset: 2,
        checklist: [
          "Preview environment reachable by the whole team",
          "Seed data covers the demo path",
        ],
      },
      {
        title: "Sprint report: what shipped, what slipped, and why",
        priority: "normal",
        estimatePoints: 2,
        checklist: [
          "Completed vs committed points recorded",
          "Every unfinished task moved or explicitly dropped",
          "Retrospective actions assigned to a person",
        ],
      },
    ],
  },
  {
    slug: "hackathon-sprint",
    name: "Hackathon sprint (3-day)",
    description:
      "A short, deliberately loose timebox for prototypes that are allowed to be thrown away.",
    category: "Product",
    useCases: ["innovation", "prototype", "team event", "short"],
    complexity: "beginner",
    lengthDays: 3,
    goalTemplate:
      "Prove or kill <idea> with a working prototype the team can try by <demo date>.",
    capacityPoints: 12,
    ceremonies: [
      {
        title: "Kickoff and team formation",
        description:
          "Pitch ideas in two minutes each, form teams, and write down what 'done' looks like on day three.",
        dayOffset: 0,
        estimatePoints: 1,
      },
      {
        title: "Day-two checkpoint",
        description:
          "Half the time is gone. Cut anything that isn't on the demo path.",
        dayOffset: 1,
        estimatePoints: 1,
      },
      {
        title: "Demo and vote",
        description: "Five minutes per team, live software only.",
        dayOffset: 2,
        estimatePoints: 2,
      },
      {
        title: "Decide: kill, park, or fund",
        description:
          "Every prototype gets an explicit verdict the same day so nothing lingers as a zombie project.",
        dayOffset: 2,
        estimatePoints: 1,
      },
    ],
    starterTasks: [
      {
        title: "Write the one-paragraph pitch",
        priority: "high",
        estimatePoints: 1,
        dueDayOffset: 0,
        checklist: [
          "Problem stated in one sentence",
          "The demo you intend to give described in two",
          "Riskiest assumption named",
        ],
      },
      {
        title: "Build the thinnest end-to-end path",
        description:
          "Fake everything that isn't the idea. Hardcoded data is fine; a broken demo is not.",
        priority: "urgent",
        estimatePoints: 5,
        dueDayOffset: 1,
        checklist: [
          "One path works end to end",
          "Runs on someone else's machine or a shared URL",
        ],
      },
      {
        title: "Prepare the three-minute demo",
        estimatePoints: 2,
        dueDayOffset: 2,
        checklist: [
          "Script written and run once out loud",
          "Fallback recording captured",
        ],
      },
      {
        title: "Write the follow-up note",
        description:
          "What you learned, what it would take to make it real, and what you'd need permission to do.",
        estimatePoints: 1,
        checklist: [
          "Learnings written down",
          "Rough cost of productionizing estimated",
        ],
      },
    ],
  },
  {
    slug: "localization-sprint",
    name: "Localization sprint",
    description:
      "Take a product from one locale to several: extraction, translation, and layout that survives longer strings.",
    category: "Product",
    useCases: ["i18n", "international", "expansion", "engineering"],
    complexity: "advanced",
    lengthDays: 14,
    goalTemplate:
      "Ship <product area> in <locales> with translated copy, correct formats, and no layout breakage.",
    capacityPoints: 36,
    ceremonies: scrumCadence(14),
    starterTasks: [
      {
        title: "Extract every hardcoded string",
        priority: "high",
        estimatePoints: 5,
        dueDayOffset: 3,
        checklist: [
          "Lint rule fails the build on new hardcoded strings",
          "Extraction covers error messages and emails",
          "Keys named by meaning, not by English text",
        ],
      },
      {
        title: "Localize dates, numbers, and currency",
        estimatePoints: 3,
        dueDayOffset: 5,
        checklist: [
          "All formatting routed through the locale helpers",
          "Timezone handling verified for a non-UTC locale",
        ],
      },
      {
        title: "Send the string catalog for translation",
        estimatePoints: 2,
        dueDayOffset: 4,
        checklist: [
          "Context notes attached to ambiguous keys",
          "Screenshot references for UI strings",
          "Return date agreed with the vendor",
        ],
      },
      {
        title: "Pseudo-localization pass for layout breakage",
        description:
          "Render every screen with strings 40% longer than English before the real translations arrive.",
        priority: "high",
        estimatePoints: 3,
        dueDayOffset: 7,
        checklist: [
          "Every screen reviewed at 360px and 1280px",
          "Truncation and overflow bugs filed",
          "RTL layout checked if in scope",
        ],
      },
      {
        title: "Native-speaker review of the shipped locales",
        estimatePoints: 3,
        checklist: [
          "One reviewer per locale signed off",
          "Terminology glossary updated",
        ],
      },
    ],
  },

  // ── Engineering ──────────────────────────────────────────────────────
  {
    slug: "one-week-delivery-sprint",
    name: "One-week delivery sprint",
    description:
      "A tight weekly cadence for small teams that would rather re-plan often than forecast far.",
    category: "Engineering",
    useCases: ["scrum", "small team", "fast cadence", "delivery"],
    complexity: "beginner",
    lengthDays: 7,
    goalTemplate: "Ship <change> to production by <day> without regressions.",
    capacityPoints: 20,
    ceremonies: scrumCadence(7),
    starterTasks: [
      {
        title: "Pick the week's single most valuable change",
        priority: "high",
        estimatePoints: 1,
        dueDayOffset: 0,
        checklist: [
          "One headline change chosen",
          "Everything else marked as fill-in work",
        ],
      },
      {
        title: "Land the change behind a flag",
        priority: "high",
        estimatePoints: 5,
        dueDayOffset: 3,
        checklist: [
          "Merged behind a feature flag",
          "Tests cover the new path",
          "Rollback is a flag flip, not a deploy",
        ],
      },
      {
        title: "Enable for internal users and watch",
        estimatePoints: 2,
        dueDayOffset: 4,
        checklist: [
          "Flag on for the team",
          "Error rates and latency compared against baseline",
        ],
      },
      {
        title: "Ship to everyone and write the changelog line",
        estimatePoints: 2,
        checklist: [
          "Flag at 100% or removed",
          "Changelog entry published",
        ],
      },
    ],
  },
  {
    slug: "bug-bash-stabilization",
    name: "Bug bash / stabilization sprint",
    description:
      "A whole timebox spent finding and fixing defects instead of adding features.",
    category: "Engineering",
    useCases: ["quality", "pre-release", "bugs", "short"],
    complexity: "beginner",
    lengthDays: 5,
    goalTemplate:
      "Drive <area> to zero known P0/P1 defects before <release date>.",
    capacityPoints: 20,
    ceremonies: [
      {
        title: "Bug bash kickoff and scope",
        description:
          "Name the surface under test, hand out areas so two people don't test the same screen, and agree the severity scale.",
        dayOffset: 0,
        estimatePoints: 1,
      },
      {
        title: "Live bug bash session",
        description:
          "Two focused hours with everyone in the product at once, filing as they go. Chaotic on purpose.",
        dayOffset: 0,
        estimatePoints: 3,
      },
      {
        title: "Triage the haul",
        description:
          "Severity, owner, and fix-or-won't-fix on every filed bug. Duplicates merged, not ignored.",
        dayOffset: 1,
        estimatePoints: 2,
      },
      {
        title: "Daily burn review",
        dayOffset: 2,
        estimatePoints: 1,
        recurrence: "daily",
      },
      {
        title: "Exit review and go/no-go",
        description:
          "Remaining defects read out by severity; a release decision made in the room.",
        dayOffset: 4,
        estimatePoints: 1,
      },
    ],
    starterTasks: [
      {
        title: "Define severity levels and the exit bar",
        priority: "high",
        estimatePoints: 1,
        dueDayOffset: 0,
        checklist: [
          "P0–P3 defined in one line each",
          "Exit bar agreed (e.g. zero P0/P1, P2s triaged)",
          "Bug template includes steps, expected, actual, environment",
        ],
      },
      {
        title: "Assign test areas to every participant",
        estimatePoints: 1,
        dueDayOffset: 0,
        checklist: [
          "Every surface has exactly one owner",
          "Mobile and desktop both covered",
          "One participant assigned to the unhappy paths",
        ],
      },
      {
        title: "Fix all P0 defects",
        priority: "urgent",
        estimatePoints: 8,
        dueDayOffset: 3,
        checklist: [
          "Every P0 fixed and verified by the reporter",
          "Each fix has a regression test",
        ],
      },
      {
        title: "Fix or explicitly defer every P1",
        priority: "high",
        estimatePoints: 5,
        dueDayOffset: 4,
        checklist: [
          "P1s fixed or deferred with a written reason",
          "Deferred items carry a due date",
        ],
      },
      {
        title: "Write the stabilization summary",
        estimatePoints: 2,
        checklist: [
          "Found vs fixed counts recorded",
          "Recurring root causes named",
          "Follow-up prevention work filed",
        ],
      },
    ],
  },
  {
    slug: "hardening-tech-debt",
    name: "Hardening and tech-debt sprint",
    description:
      "Pay down the debt the last few feature sprints created, with a measurable before-and-after.",
    category: "Engineering",
    useCases: ["quality", "refactor", "maintenance", "reliability"],
    complexity: "intermediate",
    lengthDays: 10,
    goalTemplate:
      "Reduce <debt metric — flaky tests, p95 latency, error rate> from <before> to <after> without changing behaviour.",
    capacityPoints: 30,
    ceremonies: scrumCadence(10),
    starterTasks: [
      {
        title: "Measure the baseline",
        description:
          "A hardening sprint with no numbers is a vibe. Capture the metrics you intend to move before touching code.",
        priority: "high",
        estimatePoints: 2,
        dueDayOffset: 0,
        checklist: [
          "Current values recorded for each target metric",
          "Measurement method written down so it can be repeated",
        ],
      },
      {
        title: "Rank debt by pain, not by age",
        estimatePoints: 2,
        dueDayOffset: 1,
        checklist: [
          "Each item scored by how often it hurts someone",
          "Top five chosen; the rest stays in the backlog",
        ],
      },
      {
        title: "Kill the flakiest tests",
        priority: "high",
        estimatePoints: 5,
        dueDayOffset: 5,
        checklist: [
          "Top flaky tests fixed or deleted",
          "CI pass rate measured over 20 runs",
        ],
      },
      {
        title: "Delete dead code and unused flags",
        estimatePoints: 3,
        dueDayOffset: 6,
        checklist: [
          "Flags at 100% for 30+ days removed",
          "Unreferenced modules deleted",
          "No behaviour change confirmed by tests",
        ],
      },
      {
        title: "Re-measure and publish the delta",
        estimatePoints: 2,
        checklist: [
          "Metrics re-measured the same way",
          "Delta published to the team",
          "Guardrail added so the metric can't silently regress",
        ],
      },
    ],
  },
  {
    slug: "performance-sprint",
    name: "Performance optimization sprint",
    description:
      "Profile first, fix second: a timebox aimed at a specific latency or cost number.",
    category: "Engineering",
    useCases: ["performance", "latency", "reliability", "measurement"],
    complexity: "advanced",
    lengthDays: 10,
    goalTemplate:
      "Bring <endpoint or screen> p95 from <before> to under <target> without regressing correctness.",
    capacityPoints: 28,
    ceremonies: scrumCadence(10),
    starterTasks: [
      {
        title: "Instrument and capture a profile under real load",
        priority: "urgent",
        estimatePoints: 5,
        dueDayOffset: 1,
        checklist: [
          "Traces captured from production-like traffic",
          "Top five cost centres ranked",
          "Profile attached to this task",
        ],
      },
      {
        title: "Fix the top cost centre",
        priority: "high",
        estimatePoints: 8,
        dueDayOffset: 5,
        checklist: [
          "Change measured in isolation",
          "Improvement holds under load test",
          "No correctness regression in the test suite",
        ],
      },
      {
        title: "Add a performance regression guard",
        estimatePoints: 3,
        dueDayOffset: 7,
        checklist: [
          "Budget defined for the target metric",
          "CI or monitoring alerts when the budget is exceeded",
        ],
      },
      {
        title: "Document what was slow and why",
        estimatePoints: 2,
        checklist: [
          "Root causes written up",
          "Patterns to avoid added to the engineering guide",
        ],
      },
    ],
  },
  {
    slug: "migration-sprint",
    name: "Migration sprint",
    description:
      "Move a system from old to new with a dual-write window and a rehearsed rollback.",
    category: "Engineering",
    useCases: ["infrastructure", "database", "risky change", "cutover"],
    complexity: "advanced",
    lengthDays: 14,
    goalTemplate:
      "Migrate <system> from <old> to <new> with no data loss and under <downtime budget> of downtime.",
    capacityPoints: 34,
    ceremonies: [
      ...scrumCadence(14),
      {
        title: "Cutover rehearsal",
        description:
          "Run the whole migration against a copy, on the clock, with the rollback path exercised at the end.",
        dayOffset: 9,
        estimatePoints: 5,
      },
      {
        title: "Go/no-go review",
        description:
          "Rehearsal results, rollback plan, and on-call coverage reviewed before anyone touches production.",
        dayOffset: 11,
        estimatePoints: 1,
      },
    ],
    starterTasks: [
      {
        title: "Write the migration plan and rollback plan",
        priority: "urgent",
        estimatePoints: 3,
        dueDayOffset: 2,
        checklist: [
          "Step-by-step cutover sequence written",
          "Rollback path defined for every step",
          "Owner and on-call named for the cutover window",
        ],
      },
      {
        title: "Build the backfill and verify it",
        priority: "high",
        estimatePoints: 8,
        dueDayOffset: 6,
        checklist: [
          "Backfill is idempotent and resumable",
          "Row counts and checksums match between systems",
        ],
      },
      {
        title: "Dual-write behind a flag",
        priority: "high",
        estimatePoints: 5,
        dueDayOffset: 8,
        checklist: [
          "Writes land in both systems",
          "Divergence alarm in place",
          "Read path still served by the old system",
        ],
      },
      {
        title: "Flip reads and monitor",
        priority: "urgent",
        estimatePoints: 3,
        dueDayOffset: 12,
        checklist: [
          "Reads served by the new system",
          "Error and latency dashboards watched for 24h",
          "Rollback rehearsed and available for one week",
        ],
      },
      {
        title: "Decommission the old system",
        estimatePoints: 3,
        checklist: [
          "Old system read-only for the agreed soak period",
          "Final backup archived",
          "Cost savings recorded",
        ],
      },
    ],
  },
  {
    slug: "api-integration-sprint",
    name: "API integration sprint",
    description:
      "Integrate a third-party API end to end, including the failure modes everyone forgets.",
    category: "Engineering",
    useCases: ["integration", "third-party", "backend", "partnership"],
    complexity: "intermediate",
    lengthDays: 10,
    goalTemplate:
      "Integrate <provider> so <user action> works end to end, with retries, rate limits, and monitoring.",
    capacityPoints: 28,
    ceremonies: scrumCadence(10),
    starterTasks: [
      {
        title: "Spike the API against a sandbox account",
        priority: "high",
        estimatePoints: 3,
        dueDayOffset: 1,
        checklist: [
          "Sandbox credentials stored as secrets, not in code",
          "Happy path called successfully from our runtime",
          "Rate limits and quotas documented",
        ],
      },
      {
        title: "Build the client with retries and backoff",
        priority: "high",
        estimatePoints: 5,
        dueDayOffset: 4,
        checklist: [
          "Transient errors retried with exponential backoff",
          "Timeouts set on every call",
          "Requests are idempotent or keyed",
        ],
      },
      {
        title: "Handle the failure modes explicitly",
        estimatePoints: 5,
        dueDayOffset: 6,
        checklist: [
          "Provider outage degrades gracefully",
          "Auth expiry refreshes without user action",
          "Partial failures surface a useful message",
        ],
      },
      {
        title: "Add monitoring and a synthetic check",
        estimatePoints: 3,
        dueDayOffset: 8,
        checklist: [
          "Success rate and latency dashboards live",
          "Alert routes to a real on-call person",
        ],
      },
      {
        title: "Document the integration for the next engineer",
        estimatePoints: 2,
        checklist: [
          "Auth model and secrets rotation written down",
          "Known provider quirks recorded",
        ],
      },
    ],
  },
  {
    slug: "mobile-release-sprint",
    name: "Mobile release sprint",
    description:
      "A release train that accounts for store review, staged rollout, and the users who never update.",
    category: "Engineering",
    useCases: ["mobile", "release", "app store", "rollout"],
    complexity: "intermediate",
    lengthDays: 14,
    goalTemplate:
      "Ship version <x.y> of <app> to <platforms> with a staged rollout and no crash-rate regression.",
    capacityPoints: 32,
    ceremonies: [
      ...scrumCadence(14),
      {
        title: "Release candidate cut",
        description:
          "Branch cut, version bumped, release notes drafted. Only fixes land after this point.",
        dayOffset: 9,
        estimatePoints: 2,
      },
      {
        title: "Store submission",
        description:
          "Submit early enough that review time isn't on the critical path.",
        dayOffset: 10,
        estimatePoints: 2,
      },
    ],
    starterTasks: [
      {
        title: "Confirm minimum supported OS versions",
        estimatePoints: 1,
        dueDayOffset: 1,
        checklist: [
          "Install base per OS version pulled from analytics",
          "Drops announced before they ship",
        ],
      },
      {
        title: "Regression-test the upgrade path",
        priority: "high",
        estimatePoints: 5,
        dueDayOffset: 8,
        checklist: [
          "Upgrade from the two previous versions tested",
          "Local data and sessions survive the upgrade",
          "Offline behaviour verified",
        ],
      },
      {
        title: "Write release notes and store metadata",
        estimatePoints: 2,
        dueDayOffset: 9,
        checklist: [
          "Notes written for users, not for engineers",
          "Screenshots refreshed if the UI changed",
        ],
      },
      {
        title: "Staged rollout with crash monitoring",
        priority: "urgent",
        estimatePoints: 3,
        dueDayOffset: 12,
        checklist: [
          "Rollout starts at a small percentage",
          "Crash-free rate compared with the previous version",
          "Halt criteria agreed before the rollout starts",
        ],
      },
    ],
  },

  // ── Design ───────────────────────────────────────────────────────────
  {
    slug: "design-sprint-5-day",
    name: "Design sprint (5-day)",
    description:
      "The Google Ventures format: map, sketch, decide, prototype, test — a decision in a week.",
    category: "Design",
    useCases: ["discovery", "prototype", "validation", "workshop"],
    complexity: "intermediate",
    lengthDays: 5,
    goalTemplate:
      "Decide whether <solution idea> solves <problem> for <user segment>, based on five user tests by Friday.",
    capacityPoints: 20,
    ceremonies: [
      {
        title: "Day 1 — Map the problem",
        description:
          "Long-term goal, sprint questions, a map of the journey, expert interviews, and a target chosen on the map.",
        dayOffset: 0,
        estimatePoints: 5,
      },
      {
        title: "Day 2 — Sketch solutions",
        description:
          "Lightning demos, then everyone sketches alone. No group brainstorm.",
        dayOffset: 1,
        estimatePoints: 5,
      },
      {
        title: "Day 3 — Decide and storyboard",
        description:
          "Art museum, heat map, speed critique, straw poll, decider vote, then a storyboard of the prototype.",
        dayOffset: 2,
        estimatePoints: 5,
      },
      {
        title: "Day 4 — Build the prototype",
        description:
          "A realistic façade, not a product. Divide and conquer; someone owns the interview script in parallel.",
        dayOffset: 3,
        estimatePoints: 5,
      },
      {
        title: "Day 5 — Test with five users",
        description:
          "Five one-on-one interviews, the team watching together and taking notes on a grid.",
        dayOffset: 4,
        estimatePoints: 5,
      },
    ],
    starterTasks: [
      {
        title: "Recruit and schedule five target users",
        description:
          "Book this first — the sprint fails on Friday if recruiting starts on Wednesday.",
        priority: "urgent",
        estimatePoints: 3,
        dueDayOffset: 0,
        checklist: [
          "Screener written so participants match the target segment",
          "Five interviews scheduled for day five",
          "Incentives arranged and confirmed",
        ],
      },
      {
        title: "Name the decider and clear their calendar",
        priority: "high",
        estimatePoints: 1,
        dueDayOffset: 0,
        checklist: [
          "Decider identified and committed for all five days",
          "Team calendars cleared",
        ],
      },
      {
        title: "Write the sprint questions",
        estimatePoints: 2,
        dueDayOffset: 0,
        checklist: [
          "Long-term goal written as an optimistic sentence",
          "Sprint questions written as 'Can we…?' statements",
        ],
      },
      {
        title: "Build the testable prototype",
        priority: "high",
        estimatePoints: 8,
        dueDayOffset: 3,
        checklist: [
          "Every screen on the test path is clickable",
          "Copy is real, not lorem ipsum",
          "Run through once end to end before testing",
        ],
      },
      {
        title: "Write up the decision and next step",
        priority: "high",
        estimatePoints: 3,
        checklist: [
          "Patterns across the five interviews summarized",
          "Each sprint question answered yes / no / unclear",
          "Explicit decision: pursue, iterate, or stop",
        ],
      },
    ],
  },
  {
    slug: "design-system-sprint",
    name: "Design system sprint",
    description:
      "Build or consolidate shared components so product teams stop reinventing the same button.",
    category: "Design",
    useCases: ["design system", "components", "consistency", "front-end"],
    complexity: "advanced",
    lengthDays: 14,
    goalTemplate:
      "Ship <component set> as documented, accessible primitives adopted by <first consumer team>.",
    capacityPoints: 34,
    ceremonies: scrumCadence(14),
    starterTasks: [
      {
        title: "Audit existing variants in the product",
        description:
          "Screenshot every button, input, and card in the wild. The count is usually the argument for doing this work.",
        priority: "high",
        estimatePoints: 5,
        dueDayOffset: 2,
        checklist: [
          "Every existing variant catalogued with a screenshot",
          "Duplicates grouped into intended variants",
          "Retirement list agreed with product teams",
        ],
      },
      {
        title: "Define the token layer",
        estimatePoints: 5,
        dueDayOffset: 4,
        checklist: [
          "Color, spacing, radius, and type tokens named by role, not value",
          "Light and dark values defined for each token",
        ],
      },
      {
        title: "Build the first five components",
        priority: "high",
        estimatePoints: 8,
        dueDayOffset: 9,
        checklist: [
          "Each component keyboard-operable and screen-reader labelled",
          "States covered: default, hover, focus, disabled, loading, error",
          "Props documented with examples",
        ],
      },
      {
        title: "Migrate one real screen onto the system",
        description:
          "A component library nobody uses is a side project. Prove adoption on a real screen this sprint.",
        priority: "high",
        estimatePoints: 5,
        dueDayOffset: 12,
        checklist: [
          "Screen renders entirely from system components",
          "Visual diff reviewed with design",
        ],
      },
      {
        title: "Publish contribution guidelines",
        estimatePoints: 3,
        checklist: [
          "How to propose a new component written down",
          "Review and versioning process agreed",
        ],
      },
    ],
  },
  {
    slug: "accessibility-sprint",
    name: "Accessibility remediation sprint",
    description:
      "Audit against WCAG, fix the blocking issues, and leave behind checks that prevent regressions.",
    category: "Design",
    useCases: ["accessibility", "compliance", "quality", "front-end"],
    complexity: "intermediate",
    lengthDays: 10,
    goalTemplate:
      "Bring <product area> to WCAG 2.2 AA with zero blocking issues for keyboard and screen-reader users.",
    capacityPoints: 26,
    ceremonies: scrumCadence(10),
    starterTasks: [
      {
        title: "Run an automated audit across key flows",
        priority: "high",
        estimatePoints: 3,
        dueDayOffset: 1,
        checklist: [
          "Automated scan run on every key screen",
          "Findings deduplicated into real issues",
          "Known false positives annotated",
        ],
      },
      {
        title: "Manual keyboard-only pass",
        description:
          "Automated tools catch maybe a third of real problems. Unplug the mouse and try to do the job.",
        priority: "high",
        estimatePoints: 5,
        dueDayOffset: 3,
        checklist: [
          "Every interactive element reachable by keyboard",
          "Focus order matches visual order",
          "Focus is always visible",
          "No keyboard traps",
        ],
      },
      {
        title: "Screen-reader pass on the primary flow",
        estimatePoints: 5,
        dueDayOffset: 5,
        checklist: [
          "Flow completed with a screen reader end to end",
          "Images, icons, and controls have meaningful names",
          "Dynamic updates announced",
        ],
      },
      {
        title: "Fix contrast and text sizing issues",
        estimatePoints: 3,
        dueDayOffset: 7,
        checklist: [
          "Text meets 4.5:1 (3:1 for large text)",
          "Layout survives 200% zoom",
        ],
      },
      {
        title: "Add accessibility checks to CI",
        estimatePoints: 3,
        checklist: [
          "Automated checks run on pull requests",
          "Checklist added to the definition of done",
        ],
      },
    ],
  },

  // ── Research ─────────────────────────────────────────────────────────
  {
    slug: "discovery-research-sprint",
    name: "Discovery / research sprint",
    description:
      "Answer a question before committing engineering time — the output is a decision, not a feature.",
    category: "Research",
    useCases: ["discovery", "user research", "validation", "pre-build"],
    complexity: "intermediate",
    lengthDays: 10,
    goalTemplate:
      "Decide whether to build <idea> by answering: <the one question that would change our mind>.",
    capacityPoints: 24,
    ceremonies: [
      {
        title: "Framing session",
        description:
          "Write the question, the decision it feeds, and what evidence would change the answer.",
        dayOffset: 0,
        estimatePoints: 2,
      },
      {
        title: "Daily findings note",
        description:
          "One paragraph a day so insight doesn't pile up until the readout.",
        dayOffset: 1,
        estimatePoints: 1,
        recurrence: "daily",
      },
      {
        title: "Mid-sprint synthesis checkpoint",
        dayOffset: 5,
        estimatePoints: 2,
      },
      {
        title: "Readout to stakeholders",
        description:
          "Findings, confidence level, and a recommendation someone can act on.",
        dayOffset: 9,
        estimatePoints: 3,
      },
      {
        title: "Retrospective",
        dayOffset: 9,
        estimatePoints: 1,
      },
    ],
    starterTasks: [
      {
        title: "Write the research question and decision it informs",
        priority: "urgent",
        estimatePoints: 2,
        dueDayOffset: 0,
        checklist: [
          "One primary question, at most three secondary",
          "Decision named, with the person who will make it",
          "Kill criteria written: what result stops this idea",
        ],
      },
      {
        title: "Recruit participants",
        priority: "high",
        estimatePoints: 3,
        dueDayOffset: 2,
        checklist: [
          "Screener matches the real target segment",
          "At least five sessions booked",
          "Consent and recording permissions handled",
        ],
      },
      {
        title: "Review what we already know",
        description:
          "Existing tickets, support transcripts, analytics, and last year's research. Most discovery starts by rediscovering.",
        estimatePoints: 3,
        dueDayOffset: 3,
        checklist: [
          "Prior research and support themes summarized",
          "Relevant analytics pulled",
          "Gaps the new research must fill listed",
        ],
      },
      {
        title: "Run the sessions",
        priority: "high",
        estimatePoints: 8,
        dueDayOffset: 7,
        checklist: [
          "Script followed with open, non-leading questions",
          "Notes captured in a shared grid",
          "Recordings stored with consent noted",
        ],
      },
      {
        title: "Synthesize into a recommendation",
        priority: "high",
        estimatePoints: 5,
        checklist: [
          "Patterns backed by at least three participants",
          "Confidence level stated honestly",
          "Recommendation is build / don't build / learn more",
        ],
      },
    ],
  },
  {
    slug: "user-testing-sprint",
    name: "Usability testing sprint",
    description:
      "Put a real build in front of real users and fix what trips them up, in one week.",
    category: "Research",
    useCases: ["usability", "validation", "iteration", "short"],
    complexity: "beginner",
    lengthDays: 7,
    goalTemplate:
      "Find and fix the top usability failures in <flow>, measured by task completion across <n> participants.",
    capacityPoints: 18,
    ceremonies: [
      {
        title: "Test plan review",
        dayOffset: 0,
        estimatePoints: 2,
      },
      {
        title: "Daily debrief after sessions",
        dayOffset: 2,
        estimatePoints: 1,
        recurrence: "daily",
      },
      {
        title: "Findings readout",
        dayOffset: 5,
        estimatePoints: 2,
      },
      {
        title: "Retrospective",
        dayOffset: 6,
        estimatePoints: 1,
      },
    ],
    starterTasks: [
      {
        title: "Write realistic task scenarios",
        description:
          "Give people a goal, not instructions. 'Book a room for next Tuesday', not 'click the calendar icon'.",
        priority: "high",
        estimatePoints: 2,
        dueDayOffset: 0,
        checklist: [
          "Three to five tasks written as goals",
          "Success criteria defined per task",
          "Pilot run with a colleague first",
        ],
      },
      {
        title: "Run six sessions",
        priority: "high",
        estimatePoints: 5,
        dueDayOffset: 4,
        checklist: [
          "Sessions recorded with consent",
          "Observers stayed silent during tasks",
          "Completion and struggle logged per task",
        ],
      },
      {
        title: "Rank issues by severity and frequency",
        estimatePoints: 3,
        dueDayOffset: 5,
        checklist: [
          "Every issue tagged with how many participants hit it",
          "Blocking issues separated from annoyances",
        ],
      },
      {
        title: "Fix the top three blocking issues",
        priority: "high",
        estimatePoints: 5,
        checklist: [
          "Fixes shipped or scheduled with an owner",
          "Re-test planned to confirm the fix",
        ],
      },
    ],
  },

  // ── Marketing ────────────────────────────────────────────────────────
  {
    slug: "launch-sprint",
    name: "Launch sprint",
    description:
      "Everything that has to be true on launch day, worked backwards from the date.",
    category: "Marketing",
    useCases: ["launch", "go-to-market", "cross-functional", "release"],
    complexity: "advanced",
    lengthDays: 14,
    goalTemplate:
      "Launch <product/feature> on <date> to <audience>, hitting <primary launch metric> in week one.",
    capacityPoints: 36,
    ceremonies: [
      ...scrumCadence(14),
      {
        title: "Launch readiness review",
        description:
          "Every workstream reports ready / not ready against its checklist. Not-ready gets a decision, not a nod.",
        dayOffset: 11,
        estimatePoints: 2,
      },
      {
        title: "Launch day war room",
        description:
          "Everyone reachable in one channel for the first hours: monitoring, support queue, and comms.",
        dayOffset: 12,
        estimatePoints: 3,
      },
    ],
    starterTasks: [
      {
        title: "Write the positioning and key messages",
        priority: "urgent",
        estimatePoints: 3,
        dueDayOffset: 2,
        checklist: [
          "One-sentence positioning agreed",
          "Three key messages with proof points",
          "Objections and answers written",
        ],
      },
      {
        title: "Build the launch page",
        priority: "high",
        estimatePoints: 5,
        dueDayOffset: 7,
        checklist: [
          "Copy reviewed and approved",
          "Analytics and conversion tracking verified",
          "Renders correctly at 360px and 1280px",
        ],
      },
      {
        title: "Prepare the announcement set",
        estimatePoints: 5,
        dueDayOffset: 9,
        checklist: [
          "Email drafted and audience segmented",
          "Social posts scheduled",
          "Changelog and in-app notice ready",
        ],
      },
      {
        title: "Brief support and sales",
        description:
          "The people who take the questions should not learn about the launch from the announcement.",
        priority: "high",
        estimatePoints: 3,
        dueDayOffset: 10,
        checklist: [
          "FAQ and known limitations shared",
          "Support macros and docs updated",
          "Demo walkthrough delivered to sales",
        ],
      },
      {
        title: "Set up the launch dashboard",
        estimatePoints: 3,
        dueDayOffset: 11,
        checklist: [
          "Primary metric visible in real time",
          "Error rates and support volume tracked alongside",
        ],
      },
      {
        title: "Week-one launch report",
        estimatePoints: 3,
        checklist: [
          "Results against the launch metric written up",
          "Feedback themes collected",
          "Follow-up work filed",
        ],
      },
    ],
  },
  {
    slug: "growth-experiment-sprint",
    name: "Growth experiment sprint",
    description:
      "Run a small number of honest experiments with pre-declared success criteria.",
    category: "Marketing",
    useCases: ["growth", "experimentation", "conversion", "analytics"],
    complexity: "intermediate",
    lengthDays: 14,
    goalTemplate:
      "Move <metric> by <target> by running <n> experiments on <funnel stage>.",
    capacityPoints: 28,
    ceremonies: [
      ...scrumCadence(14),
      {
        title: "Experiment review board",
        description:
          "Each proposed experiment defended in five minutes: hypothesis, metric, sample size, and what result would kill it.",
        dayOffset: 1,
        estimatePoints: 2,
      },
      {
        title: "Results readout",
        description:
          "Report losers as loudly as winners; the point is learning, not a scoreboard.",
        dayOffset: 12,
        estimatePoints: 2,
      },
    ],
    starterTasks: [
      {
        title: "Pick the one funnel stage to attack",
        priority: "high",
        estimatePoints: 2,
        dueDayOffset: 0,
        checklist: [
          "Funnel drop-offs measured before choosing",
          "Stage with the largest addressable loss selected",
        ],
      },
      {
        title: "Write hypotheses with pre-declared success criteria",
        description:
          "Deciding what counts as a win after seeing the data is how teams fool themselves for a whole quarter.",
        priority: "high",
        estimatePoints: 3,
        dueDayOffset: 2,
        checklist: [
          "Each hypothesis states expected effect and direction",
          "Minimum detectable effect and sample size calculated",
          "Stop criteria written before launch",
        ],
      },
      {
        title: "Verify tracking before launching anything",
        priority: "urgent",
        estimatePoints: 3,
        dueDayOffset: 3,
        checklist: [
          "Events fire correctly in a test session",
          "Assignment is stable per user",
          "Guardrail metrics instrumented",
        ],
      },
      {
        title: "Launch and monitor the experiments",
        estimatePoints: 5,
        dueDayOffset: 10,
        checklist: [
          "Experiments running with balanced assignment",
          "No peeking-driven early calls",
          "Guardrails checked daily",
        ],
      },
      {
        title: "Write up results and decisions",
        estimatePoints: 3,
        checklist: [
          "Each experiment marked ship / iterate / kill",
          "Learnings added to the experiment log",
        ],
      },
    ],
  },

  // ── Content ──────────────────────────────────────────────────────────
  {
    slug: "content-production-sprint",
    name: "Content production sprint",
    description:
      "A publishing cadence with real editorial gates instead of a doc full of good intentions.",
    category: "Content",
    useCases: ["editorial", "publishing", "seo", "marketing"],
    complexity: "beginner",
    lengthDays: 14,
    goalTemplate:
      "Publish <n> pieces on <theme> for <audience>, each with a distribution plan.",
    capacityPoints: 26,
    ceremonies: [
      {
        title: "Editorial planning",
        description:
          "Lock the slate: topic, angle, owner, and publish date per piece.",
        dayOffset: 0,
        estimatePoints: 2,
      },
      {
        title: "Weekly editorial standup",
        dayOffset: 1,
        estimatePoints: 1,
        recurrence: "weekly",
      },
      {
        title: "Mid-sprint draft review",
        description: "Every piece must exist as a draft by now, however rough.",
        dayOffset: 7,
        estimatePoints: 2,
      },
      {
        title: "Publish and distribute",
        dayOffset: 12,
        estimatePoints: 2,
      },
      {
        title: "Retrospective",
        dayOffset: 13,
        estimatePoints: 1,
      },
    ],
    starterTasks: [
      {
        title: "Lock the editorial slate",
        priority: "high",
        estimatePoints: 2,
        dueDayOffset: 0,
        checklist: [
          "Each piece has a working title and angle",
          "Owner and publish date assigned",
          "Search or audience rationale noted",
        ],
      },
      {
        title: "Write outlines and get them approved",
        description:
          "Reviewing an outline takes ten minutes; rewriting a finished draft takes a day.",
        estimatePoints: 5,
        dueDayOffset: 3,
        checklist: [
          "Outline covers the argument and evidence",
          "Reviewer approved before drafting",
        ],
      },
      {
        title: "Draft the pieces",
        priority: "high",
        estimatePoints: 8,
        dueDayOffset: 7,
        checklist: [
          "Every piece drafted end to end",
          "Claims sourced or linked",
          "Original examples, not paraphrased competitors",
        ],
      },
      {
        title: "Edit, fact-check, and produce assets",
        estimatePoints: 5,
        dueDayOffset: 10,
        checklist: [
          "Line edit complete",
          "Facts and figures verified",
          "Images and alt text produced",
        ],
      },
      {
        title: "Publish and distribute each piece",
        estimatePoints: 3,
        checklist: [
          "Metadata, canonical URL, and internal links set",
          "Distribution executed on the agreed channels",
          "Performance check scheduled for two weeks out",
        ],
      },
    ],
  },
  {
    slug: "documentation-sprint",
    name: "Documentation sprint",
    description:
      "Close the gap between what the product does and what the docs say it does.",
    category: "Content",
    useCases: ["documentation", "developer experience", "support", "short"],
    complexity: "beginner",
    lengthDays: 7,
    goalTemplate:
      "Document <product area> well enough that a new user completes <key task> without asking anyone.",
    capacityPoints: 18,
    ceremonies: [
      {
        title: "Docs planning",
        description:
          "Rank pages by how often support answers the same question by hand.",
        dayOffset: 0,
        estimatePoints: 2,
      },
      {
        title: "Daily standup",
        dayOffset: 1,
        estimatePoints: 1,
        recurrence: "daily",
      },
      {
        title: "Docs review",
        description:
          "An engineer and a non-expert both read every new page before it merges.",
        dayOffset: 5,
        estimatePoints: 2,
      },
      {
        title: "Retrospective",
        dayOffset: 6,
        estimatePoints: 1,
      },
    ],
    starterTasks: [
      {
        title: "Pull the top support questions",
        priority: "high",
        estimatePoints: 2,
        dueDayOffset: 0,
        checklist: [
          "Top 20 recurring questions listed",
          "Each mapped to a page that exists or needs writing",
        ],
      },
      {
        title: "Write the getting-started path",
        description:
          "One linear path from zero to a first success. No branching until the reader has won once.",
        priority: "high",
        estimatePoints: 5,
        dueDayOffset: 3,
        checklist: [
          "Every step tested on a clean environment",
          "Copy-pasteable commands or snippets",
          "Expected output shown for each step",
        ],
      },
      {
        title: "Fix or delete stale pages",
        estimatePoints: 3,
        dueDayOffset: 5,
        checklist: [
          "Pages describing removed behaviour corrected or deleted",
          "Redirects added for anything removed",
        ],
      },
      {
        title: "Test the docs on someone new",
        estimatePoints: 3,
        checklist: [
          "A newcomer completed the key task using only the docs",
          "Every place they got stuck is filed as a task",
        ],
      },
    ],
  },

  // ── Sales ────────────────────────────────────────────────────────────
  {
    slug: "quarter-close-sprint",
    name: "Quarter-close sales sprint",
    description:
      "The last two weeks of a quarter: qualify hard, unblock deals, and stop working dead ones.",
    category: "Sales",
    useCases: ["pipeline", "quota", "closing", "revenue"],
    complexity: "intermediate",
    lengthDays: 14,
    goalTemplate:
      "Close <amount> in committed pipeline by <quarter end> and hand off a clean forecast for next quarter.",
    capacityPoints: 30,
    ceremonies: [
      {
        title: "Pipeline review and commit",
        description:
          "Every deal above the threshold reviewed: next step, decision maker, and a date. No next step means no commit.",
        dayOffset: 0,
        estimatePoints: 3,
      },
      {
        title: "Daily deal standup",
        dayOffset: 1,
        estimatePoints: 1,
        recurrence: "daily",
      },
      {
        title: "Mid-sprint forecast call",
        dayOffset: 7,
        estimatePoints: 2,
      },
      {
        title: "Close-out review",
        dayOffset: 13,
        estimatePoints: 2,
      },
    ],
    starterTasks: [
      {
        title: "Scrub the pipeline honestly",
        description:
          "Move anything without a confirmed next step out of commit. A clean forecast beats a flattering one.",
        priority: "urgent",
        estimatePoints: 3,
        dueDayOffset: 1,
        checklist: [
          "Every commit deal has a dated next step",
          "Deals without an identified decision maker downgraded",
          "Stale opportunities closed-lost with a reason",
        ],
      },
      {
        title: "Unblock the top five deals",
        priority: "high",
        estimatePoints: 8,
        dueDayOffset: 7,
        checklist: [
          "Blocker named per deal (legal, security, budget, champion)",
          "Internal owner assigned to each blocker",
          "Executive sponsor engaged where needed",
        ],
      },
      {
        title: "Clear security and legal reviews early",
        estimatePoints: 5,
        dueDayOffset: 5,
        checklist: [
          "Security questionnaires submitted",
          "Redlines routed to legal with a deadline",
        ],
      },
      {
        title: "Prepare handoffs for won deals",
        estimatePoints: 3,
        checklist: [
          "Onboarding kickoff scheduled before signature where possible",
          "Account context written for the CS owner",
        ],
      },
      {
        title: "Build next quarter's starting pipeline",
        estimatePoints: 5,
        checklist: [
          "Pipeline coverage ratio calculated",
          "Gap-filling prospecting plan agreed",
        ],
      },
    ],
  },
  {
    slug: "outbound-prospecting-sprint",
    name: "Outbound prospecting sprint",
    description:
      "A focused block of new-pipeline generation with a fixed list and a real sequence.",
    category: "Sales",
    useCases: ["prospecting", "pipeline", "outbound", "sdr"],
    complexity: "beginner",
    lengthDays: 10,
    goalTemplate:
      "Book <n> qualified meetings from <segment> using <channels> by <end date>.",
    capacityPoints: 22,
    ceremonies: [
      {
        title: "Target list review",
        dayOffset: 0,
        estimatePoints: 2,
      },
      {
        title: "Daily activity standup",
        dayOffset: 1,
        estimatePoints: 1,
        recurrence: "daily",
      },
      {
        title: "Mid-sprint message review",
        description:
          "Read the replies, not just the counts — the words people push back with are the next iteration.",
        dayOffset: 5,
        estimatePoints: 2,
      },
      {
        title: "Results review and retro",
        dayOffset: 9,
        estimatePoints: 2,
      },
    ],
    starterTasks: [
      {
        title: "Build and verify the target list",
        priority: "high",
        estimatePoints: 3,
        dueDayOffset: 1,
        checklist: [
          "Accounts match the stated ICP criteria",
          "Contact data verified, bounces removed",
          "Duplicates against existing pipeline removed",
        ],
      },
      {
        title: "Write the sequence",
        estimatePoints: 3,
        dueDayOffset: 2,
        checklist: [
          "Each touch offers something useful on its own",
          "First line is specific to the account, not a mail merge",
          "Clear, low-friction ask in every message",
        ],
      },
      {
        title: "Run the sequence at the committed volume",
        priority: "high",
        estimatePoints: 8,
        dueDayOffset: 8,
        checklist: [
          "Daily touch target hit",
          "Replies answered within one business day",
          "Opt-outs honored immediately",
        ],
      },
      {
        title: "Qualify booked meetings before handoff",
        estimatePoints: 3,
        checklist: [
          "Qualification notes recorded per meeting",
          "No-shows rebooked once, then closed",
        ],
      },
    ],
  },

  // ── Support ──────────────────────────────────────────────────────────
  {
    slug: "support-backlog-burndown",
    name: "Support backlog burndown",
    description:
      "Clear an aged ticket queue and fix the handful of causes generating most of it.",
    category: "Support",
    useCases: ["support", "backlog", "customer", "short"],
    complexity: "beginner",
    lengthDays: 7,
    goalTemplate:
      "Bring the <queue> backlog under <target> tickets and first-response time under <target>.",
    capacityPoints: 20,
    ceremonies: [
      {
        title: "Queue triage and split",
        dayOffset: 0,
        estimatePoints: 2,
      },
      {
        title: "Daily burn standup",
        dayOffset: 1,
        estimatePoints: 1,
        recurrence: "daily",
      },
      {
        title: "Root-cause review",
        description:
          "Which product problems generated the most tickets this week — and who owns fixing them.",
        dayOffset: 5,
        estimatePoints: 2,
      },
      {
        title: "Retrospective",
        dayOffset: 6,
        estimatePoints: 1,
      },
    ],
    starterTasks: [
      {
        title: "Triage the whole backlog once",
        priority: "urgent",
        estimatePoints: 5,
        dueDayOffset: 1,
        checklist: [
          "Every ticket categorized and assigned",
          "Duplicates merged",
          "Tickets awaiting the customer for 14+ days closed politely",
        ],
      },
      {
        title: "Answer the oldest tickets first",
        priority: "high",
        estimatePoints: 8,
        dueDayOffset: 4,
        checklist: [
          "No ticket older than the agreed age remains open",
          "Every reply is a real answer, not a holding message",
        ],
      },
      {
        title: "Write macros for the top repeat questions",
        estimatePoints: 3,
        dueDayOffset: 5,
        checklist: [
          "Top five repeat questions have a reviewed macro",
          "Each macro links to a docs page",
        ],
      },
      {
        title: "File the product fixes behind the top ticket drivers",
        priority: "high",
        estimatePoints: 3,
        checklist: [
          "Top three drivers filed as product tasks with volume data",
          "An engineering owner acknowledged each",
        ],
      },
    ],
  },
  {
    slug: "customer-onboarding-sprint",
    name: "Customer onboarding sprint",
    description:
      "Get a new customer from signature to first real value inside a fixed window.",
    category: "Support",
    useCases: ["customer success", "implementation", "onboarding", "b2b"],
    complexity: "intermediate",
    lengthDays: 14,
    goalTemplate:
      "Get <customer> from kickoff to <first value milestone> with <n> active users by <date>.",
    capacityPoints: 26,
    ceremonies: [
      {
        title: "Customer kickoff",
        description:
          "Agree success criteria, the go-live date, and who on their side owns what.",
        dayOffset: 0,
        estimatePoints: 3,
      },
      {
        title: "Weekly customer check-in",
        dayOffset: 4,
        estimatePoints: 2,
        recurrence: "weekly",
      },
      {
        title: "Internal standup",
        dayOffset: 1,
        estimatePoints: 1,
        recurrence: "daily",
      },
      {
        title: "Go-live review",
        dayOffset: 12,
        estimatePoints: 2,
      },
      {
        title: "Internal retrospective",
        dayOffset: 13,
        estimatePoints: 1,
      },
    ],
    starterTasks: [
      {
        title: "Write the mutual success plan",
        priority: "urgent",
        estimatePoints: 3,
        dueDayOffset: 1,
        checklist: [
          "Success criteria agreed in the customer's words",
          "Named owners on both sides",
          "Dates for each milestone confirmed",
        ],
      },
      {
        title: "Complete data import and configuration",
        priority: "high",
        estimatePoints: 8,
        dueDayOffset: 6,
        checklist: [
          "Data imported and spot-checked with the customer",
          "SSO, permissions, and integrations configured",
          "Sandbox verified before touching production",
        ],
      },
      {
        title: "Train the customer's admins",
        estimatePoints: 5,
        dueDayOffset: 8,
        checklist: [
          "Admin session delivered and recorded",
          "Runbook handed over",
          "Support escalation path explained",
        ],
      },
      {
        title: "Drive first real usage",
        description:
          "Configuration isn't adoption. Watch a real workflow happen in the product before calling it live.",
        priority: "high",
        estimatePoints: 5,
        dueDayOffset: 11,
        checklist: [
          "At least one real workflow completed by the customer",
          "Active-user count against target recorded",
        ],
      },
      {
        title: "Hand over to the ongoing account owner",
        estimatePoints: 3,
        checklist: [
          "Account context and open risks written up",
          "Next review scheduled",
        ],
      },
    ],
  },

  // ── Operations ───────────────────────────────────────────────────────
  {
    slug: "incident-followup-sprint",
    name: "Incident follow-up sprint",
    description:
      "The week after an incident: blameless postmortem plus the fixes that actually get done.",
    category: "Operations",
    useCases: ["incident", "postmortem", "reliability", "short"],
    complexity: "intermediate",
    lengthDays: 5,
    goalTemplate:
      "Close out <incident> with a published postmortem and every P0 action item shipped.",
    capacityPoints: 16,
    ceremonies: [
      {
        title: "Timeline reconstruction",
        description:
          "Facts only: what happened, when, and what each responder saw. No causes yet.",
        dayOffset: 0,
        estimatePoints: 3,
      },
      {
        title: "Blameless postmortem review",
        description:
          "Contributing factors, not culprits. Ask what made the mistake easy to make.",
        dayOffset: 1,
        estimatePoints: 3,
      },
      {
        title: "Daily action-item standup",
        dayOffset: 2,
        estimatePoints: 1,
        recurrence: "daily",
      },
      {
        title: "Close-out review",
        description:
          "Every action item shipped, scheduled with an owner, or explicitly dropped on the record.",
        dayOffset: 4,
        estimatePoints: 2,
      },
    ],
    starterTasks: [
      {
        title: "Reconstruct the incident timeline",
        priority: "urgent",
        estimatePoints: 3,
        dueDayOffset: 0,
        checklist: [
          "Detection, escalation, mitigation, and resolution timestamps recorded",
          "Customer impact quantified (users, duration, requests)",
          "Every responder's account collected",
        ],
      },
      {
        title: "Write the blameless postmortem",
        priority: "high",
        estimatePoints: 5,
        dueDayOffset: 2,
        checklist: [
          "Contributing factors described without naming fault",
          "Why detection took as long as it did is answered",
          "Document shared with everyone affected",
        ],
      },
      {
        title: "Ship the detection improvement",
        description:
          "If the customer told you first, the alerting is the incident.",
        priority: "urgent",
        estimatePoints: 5,
        dueDayOffset: 3,
        checklist: [
          "Alert exists that would have caught this",
          "Alert tested against the failure mode",
          "Runbook updated",
        ],
      },
      {
        title: "Schedule the remaining action items",
        estimatePoints: 2,
        checklist: [
          "Every item has an owner and a date",
          "Items nobody will do are dropped on the record, not left open",
        ],
      },
    ],
  },
  {
    slug: "okr-kickoff-sprint",
    name: "OKR planning sprint",
    description:
      "A short planning timebox that turns a quarter's ambitions into owned, measurable objectives.",
    category: "Operations",
    useCases: ["planning", "okr", "quarterly", "leadership"],
    complexity: "intermediate",
    lengthDays: 5,
    goalTemplate:
      "Agree <n> objectives for <quarter>, each with measurable key results and a named owner.",
    capacityPoints: 14,
    ceremonies: [
      {
        title: "Last quarter's scorecard",
        description:
          "Grade the previous OKRs honestly before writing new ones.",
        dayOffset: 0,
        estimatePoints: 2,
      },
      {
        title: "Draft objectives workshop",
        dayOffset: 1,
        estimatePoints: 3,
      },
      {
        title: "Cross-team dependency review",
        description:
          "Where one team's key result depends on another's work, both teams say so out loud now.",
        dayOffset: 2,
        estimatePoints: 2,
      },
      {
        title: "Commit and publish",
        dayOffset: 4,
        estimatePoints: 2,
      },
    ],
    starterTasks: [
      {
        title: "Grade last quarter's key results",
        priority: "high",
        estimatePoints: 3,
        dueDayOffset: 0,
        checklist: [
          "Every key result scored with real data",
          "Misses explained without blame",
          "Carry-over work identified",
        ],
      },
      {
        title: "Draft objectives and key results",
        priority: "high",
        estimatePoints: 5,
        dueDayOffset: 2,
        checklist: [
          "Objectives are outcomes, not project lists",
          "Each key result is a number with a baseline",
          "No more than five objectives total",
        ],
      },
      {
        title: "Pressure-test for capacity",
        description:
          "Add up what the OKRs imply in people-weeks. Most quarters die here, quietly, in March.",
        estimatePoints: 3,
        dueDayOffset: 3,
        checklist: [
          "Implied effort compared against real capacity",
          "Explicit cuts made where it doesn't fit",
        ],
      },
      {
        title: "Publish and assign owners",
        estimatePoints: 2,
        checklist: [
          "One accountable owner per objective",
          "Check-in cadence scheduled",
          "Published where the whole team can see it",
        ],
      },
    ],
  },
  {
    slug: "infra-cost-sprint",
    name: "Infrastructure cost sprint",
    description:
      "Find where the cloud bill actually goes and cut the top items without hurting reliability.",
    category: "Operations",
    useCases: ["cost", "finops", "infrastructure", "efficiency"],
    complexity: "intermediate",
    lengthDays: 10,
    goalTemplate:
      "Cut <environment> spend by <target %> without regressing availability or latency.",
    capacityPoints: 24,
    ceremonies: scrumCadence(10),
    starterTasks: [
      {
        title: "Break the bill down by service and owner",
        priority: "high",
        estimatePoints: 3,
        dueDayOffset: 1,
        checklist: [
          "Top ten line items identified",
          "Each has an owning team",
          "Untagged resources flagged",
        ],
      },
      {
        title: "Delete obviously unused resources",
        estimatePoints: 3,
        dueDayOffset: 3,
        checklist: [
          "Orphaned volumes, IPs, and snapshots removed",
          "Idle environments shut down or scheduled",
          "Removal announced before it happens",
        ],
      },
      {
        title: "Right-size the top two workloads",
        priority: "high",
        estimatePoints: 5,
        dueDayOffset: 6,
        checklist: [
          "Utilization measured over a representative period",
          "Headroom kept for peak traffic",
          "Latency compared before and after",
        ],
      },
      {
        title: "Fix the largest data-transfer or storage cost",
        estimatePoints: 5,
        dueDayOffset: 8,
        checklist: [
          "Costly path identified from real usage data",
          "Lifecycle or caching policy applied",
        ],
      },
      {
        title: "Add cost monitoring and a budget alert",
        estimatePoints: 3,
        checklist: [
          "Per-team cost visible on a dashboard",
          "Alert fires on unexpected growth",
        ],
      },
    ],
  },

  // ── Data ─────────────────────────────────────────────────────────────
  {
    slug: "analytics-instrumentation-sprint",
    name: "Analytics instrumentation sprint",
    description:
      "Make the numbers trustworthy: a defined event schema, correct tracking, and a dashboard people believe.",
    category: "Data",
    useCases: ["analytics", "instrumentation", "measurement", "data quality"],
    complexity: "intermediate",
    lengthDays: 14,
    goalTemplate:
      "Instrument <funnel or feature> so <key metric> is trustworthy and visible to <audience>.",
    capacityPoints: 30,
    ceremonies: scrumCadence(14),
    starterTasks: [
      {
        title: "Define the tracking plan",
        description:
          "Decide the events and properties before writing any tracking code — renaming events after the fact is how data debt starts.",
        priority: "high",
        estimatePoints: 5,
        dueDayOffset: 2,
        checklist: [
          "Events named consistently (object_action)",
          "Required properties defined per event",
          "Owner named for the schema",
        ],
      },
      {
        title: "Implement and verify events",
        priority: "high",
        estimatePoints: 8,
        dueDayOffset: 7,
        checklist: [
          "Each event verified in a live session",
          "No PII in event properties",
          "Client and server events reconciled",
        ],
      },
      {
        title: "Reconcile against a source of truth",
        estimatePoints: 5,
        dueDayOffset: 9,
        checklist: [
          "Counts compared against the database or billing system",
          "Discrepancies explained, not rounded away",
        ],
      },
      {
        title: "Build the dashboard people will actually open",
        estimatePoints: 5,
        dueDayOffset: 11,
        checklist: [
          "One screen answers the primary question",
          "Definitions documented next to each metric",
          "Refresh cadence stated",
        ],
      },
      {
        title: "Add data-quality monitoring",
        estimatePoints: 3,
        checklist: [
          "Alert on event volume anomalies",
          "Schema violations reported to an owner",
        ],
      },
    ],
  },
  {
    slug: "ml-model-iteration-sprint",
    name: "Model iteration sprint",
    description:
      "One measurable improvement to a model, with an offline baseline and an honest online test.",
    category: "Data",
    useCases: ["machine learning", "modeling", "evaluation", "experimentation"],
    complexity: "advanced",
    lengthDays: 14,
    goalTemplate:
      "Improve <model> on <metric> from <baseline> to <target> without regressing <guardrail metric>.",
    capacityPoints: 30,
    ceremonies: [
      ...scrumCadence(14),
      {
        title: "Model review",
        description:
          "Offline results, error analysis, and fairness checks reviewed before anything reaches users.",
        dayOffset: 10,
        estimatePoints: 3,
      },
    ],
    starterTasks: [
      {
        title: "Freeze an evaluation set and record the baseline",
        priority: "urgent",
        estimatePoints: 3,
        dueDayOffset: 1,
        checklist: [
          "Evaluation set frozen and version-controlled",
          "Baseline metrics recorded",
          "Guardrail metrics chosen",
        ],
      },
      {
        title: "Run error analysis on the current model",
        description:
          "Read a hundred actual failures. It reliably beats guessing which architecture to try next.",
        priority: "high",
        estimatePoints: 5,
        dueDayOffset: 4,
        checklist: [
          "Failure cases sampled and categorized",
          "Top three failure modes named with frequencies",
        ],
      },
      {
        title: "Run the experiments",
        estimatePoints: 8,
        dueDayOffset: 9,
        checklist: [
          "Each experiment changes one thing",
          "Results logged with configs and data versions",
          "Winner beats baseline beyond noise",
        ],
      },
      {
        title: "Check fairness and failure behaviour",
        priority: "high",
        estimatePoints: 3,
        dueDayOffset: 10,
        checklist: [
          "Performance broken down by relevant segments",
          "Behaviour on out-of-distribution input documented",
        ],
      },
      {
        title: "Ship behind a shadow or canary deployment",
        estimatePoints: 5,
        checklist: [
          "New model scored alongside the old one before switching",
          "Rollback path tested",
          "Monitoring covers drift and latency",
        ],
      },
    ],
  },

  // ── Security ─────────────────────────────────────────────────────────
  {
    slug: "security-compliance-sprint",
    name: "Security and compliance sprint",
    description:
      "Close audit findings and harden the obvious gaps, with evidence collected as you go.",
    category: "Security",
    useCases: ["security", "compliance", "soc2", "audit"],
    complexity: "advanced",
    lengthDays: 14,
    goalTemplate:
      "Close every <severity> finding from <audit/pentest> and produce evidence for <control set>.",
    capacityPoints: 30,
    ceremonies: [
      ...scrumCadence(14),
      {
        title: "Findings review with the security owner",
        dayOffset: 1,
        estimatePoints: 2,
      },
      {
        title: "Evidence review",
        description:
          "Every closed finding must have an artifact an auditor would accept, not a claim in a spreadsheet.",
        dayOffset: 11,
        estimatePoints: 3,
      },
    ],
    starterTasks: [
      {
        title: "Triage findings by severity and exploitability",
        priority: "urgent",
        estimatePoints: 3,
        dueDayOffset: 1,
        checklist: [
          "Each finding rated with a documented rationale",
          "Owner assigned per finding",
          "Accepted risks recorded with an approver",
        ],
      },
      {
        title: "Fix the critical and high findings",
        priority: "urgent",
        estimatePoints: 8,
        dueDayOffset: 8,
        checklist: [
          "Each fix verified by whoever reported the finding",
          "Regression test or detection added",
        ],
      },
      {
        title: "Review access and remove stale privileges",
        priority: "high",
        estimatePoints: 5,
        dueDayOffset: 6,
        checklist: [
          "Admin accounts reviewed and justified",
          "Departed users removed everywhere",
          "Service accounts scoped to least privilege",
          "Review evidence exported and stored",
        ],
      },
      {
        title: "Verify logging and alerting on security events",
        estimatePoints: 5,
        dueDayOffset: 10,
        checklist: [
          "Auth, privilege change, and export events logged",
          "Logs immutable and retained per policy",
          "At least one alert tested end to end",
        ],
      },
      {
        title: "Collect the evidence pack",
        estimatePoints: 3,
        checklist: [
          "Screenshots, exports, and tickets filed per control",
          "Gaps listed with remediation dates",
        ],
      },
    ],
  },

  // ── People ───────────────────────────────────────────────────────────
  {
    slug: "new-hire-onboarding-sprint",
    name: "New-hire onboarding sprint",
    description:
      "A structured first two weeks that ends with the new person shipping something real.",
    category: "People",
    useCases: ["onboarding", "hiring", "ramp-up", "team"],
    complexity: "beginner",
    lengthDays: 14,
    goalTemplate:
      "Get <new hire> from day one to a merged, shipped change by <date>, with context on <team>'s work.",
    capacityPoints: 20,
    ceremonies: [
      {
        title: "Day-one welcome and setup",
        dayOffset: 0,
        estimatePoints: 3,
      },
      {
        title: "Daily buddy check-in",
        description:
          "Fifteen minutes with their onboarding buddy — questions they wouldn't raise in a group.",
        dayOffset: 1,
        estimatePoints: 1,
        recurrence: "daily",
      },
      {
        title: "End of week one review",
        dayOffset: 4,
        estimatePoints: 2,
      },
      {
        title: "Two-week retrospective with the manager",
        description:
          "Both directions: how they're doing, and what onboarding got wrong. Fix the docs while it's fresh.",
        dayOffset: 13,
        estimatePoints: 2,
      },
    ],
    starterTasks: [
      {
        title: "Complete accounts, access, and equipment",
        priority: "urgent",
        estimatePoints: 3,
        dueDayOffset: 0,
        checklist: [
          "All tool accounts created before day one",
          "Hardware delivered and working",
          "Access matches role, nothing extra",
        ],
      },
      {
        title: "Get the development environment running",
        priority: "high",
        estimatePoints: 5,
        dueDayOffset: 2,
        checklist: [
          "Project runs locally following only the written setup guide",
          "Every gap in the guide fixed by the new hire as they hit it",
          "Tests pass locally",
        ],
      },
      {
        title: "Meet the people and read the context",
        estimatePoints: 3,
        dueDayOffset: 4,
        checklist: [
          "Intro conversations with immediate team and key partners",
          "Current roadmap and top customer problems understood",
        ],
      },
      {
        title: "Ship a first small change",
        description:
          "Pick something real but low-risk. Shipping in week one teaches more about the system than a week of reading.",
        priority: "high",
        estimatePoints: 5,
        dueDayOffset: 7,
        checklist: [
          "Change merged and deployed",
          "New hire ran the deploy themselves with a buddy watching",
        ],
      },
      {
        title: "Take on a first owned task",
        estimatePoints: 5,
        dueDayOffset: 12,
        checklist: [
          "Task scoped with the manager",
          "New hire wrote the acceptance criteria",
          "Delivered with a demo to the team",
        ],
      },
    ],
  },

  // ── Agency ───────────────────────────────────────────────────────────
  {
    slug: "agency-client-sprint",
    name: "Agency client sprint",
    description:
      "Billable client work with scope, approvals, and hours tracked against the retainer.",
    category: "Agency",
    useCases: ["client work", "retainer", "billable", "services"],
    complexity: "intermediate",
    lengthDays: 14,
    goalTemplate:
      "Deliver <scope> for <client> within <budgeted hours>, approved by <client contact>.",
    capacityPoints: 32,
    ceremonies: [
      {
        title: "Scope confirmation with the client",
        description:
          "Read the scope back to the client and get it in writing before work starts.",
        dayOffset: 0,
        estimatePoints: 3,
      },
      {
        title: "Internal daily standup",
        dayOffset: 1,
        estimatePoints: 1,
        recurrence: "daily",
      },
      {
        title: "Weekly client update",
        description:
          "Progress, hours used against budget, decisions needed. Sent whether or not there's good news.",
        dayOffset: 4,
        estimatePoints: 2,
        recurrence: "weekly",
      },
      {
        title: "Delivery review and handover",
        dayOffset: 12,
        estimatePoints: 3,
      },
      {
        title: "Internal retrospective and margin review",
        description:
          "Hours booked versus quoted, and what to price differently next time.",
        dayOffset: 13,
        estimatePoints: 2,
      },
    ],
    starterTasks: [
      {
        title: "Confirm scope, budget, and approval path",
        priority: "urgent",
        estimatePoints: 3,
        dueDayOffset: 1,
        checklist: [
          "Deliverables listed with explicit exclusions",
          "Budgeted hours per deliverable agreed",
          "Named approver and turnaround expectation confirmed",
        ],
      },
      {
        title: "Collect assets and access from the client",
        description:
          "Chase this on day one — waiting on client access is the most common reason agency sprints slip.",
        priority: "high",
        estimatePoints: 3,
        dueDayOffset: 2,
        checklist: [
          "Brand assets, credentials, and content received",
          "Blocking gaps escalated in writing",
        ],
      },
      {
        title: "Produce the first review milestone",
        priority: "high",
        estimatePoints: 8,
        dueDayOffset: 6,
        checklist: [
          "Work-in-progress shared for feedback, not just at the end",
          "Feedback captured in one place with owners",
        ],
      },
      {
        title: "Track hours against budget daily",
        estimatePoints: 2,
        dueDayOffset: 10,
        checklist: [
          "Time logged the same day it's worked",
          "Client warned before the budget is exceeded, not after",
          "Out-of-scope requests quoted as a change order",
        ],
      },
      {
        title: "Deliver, hand over, and invoice",
        estimatePoints: 3,
        checklist: [
          "Final files delivered in agreed formats",
          "Handover notes and next-step recommendations sent",
          "Invoice raised against the completed scope",
        ],
      },
    ],
  },

  // ── Personal ─────────────────────────────────────────────────────────
  {
    slug: "personal-focus-sprint",
    name: "Personal focus sprint",
    description:
      "A one-week timebox for a single personal goal, with the same honesty a team sprint demands.",
    category: "Personal",
    useCases: ["personal", "focus", "solo", "short"],
    complexity: "beginner",
    lengthDays: 7,
    goalTemplate: "Finish <the one thing> by <date>, and stop everything else.",
    capacityPoints: 10,
    ceremonies: [
      {
        title: "Plan the week",
        description:
          "Pick one outcome. Write down what you will not do this week.",
        dayOffset: 0,
        estimatePoints: 1,
      },
      {
        title: "Daily check-in",
        description: "Two minutes: on track, or what needs to change.",
        dayOffset: 1,
        estimatePoints: 1,
        recurrence: "daily",
      },
      {
        title: "Week review",
        description:
          "Did it get done? If not, why — capacity, clarity, or interest?",
        dayOffset: 6,
        estimatePoints: 1,
      },
    ],
    starterTasks: [
      {
        title: "Define the one outcome for the week",
        priority: "high",
        estimatePoints: 1,
        dueDayOffset: 0,
        checklist: [
          "Outcome is specific enough to be obviously done or not",
          "Everything else moved to next week",
        ],
      },
      {
        title: "Block the time in the calendar",
        description:
          "Work that isn't in the calendar loses to work that is.",
        estimatePoints: 1,
        dueDayOffset: 0,
        checklist: [
          "At least three focus blocks booked",
          "Notifications off during blocks",
        ],
      },
      {
        title: "Do the hardest part first",
        priority: "high",
        estimatePoints: 5,
        dueDayOffset: 3,
        checklist: [
          "The part you've been avoiding is done",
          "Anything blocking it is asked about, not waited on",
        ],
      },
      {
        title: "Finish and review",
        estimatePoints: 2,
        checklist: [
          "Outcome delivered or honestly reassessed",
          "One thing to change next week written down",
        ],
      },
    ],
  },
];

export function findSprintTemplate(slug: string): SprintTemplate | undefined {
  return SPRINT_TEMPLATES.find((t) => t.slug === slug);
}

export type SprintTemplateSummary = {
  slug: string;
  name: string;
  description: string;
  category: string;
  useCases: string[];
  complexity: SprintTemplateComplexity;
  lengthDays: number;
  goalTemplate: string;
  capacityPoints?: number;
  ceremonyCount: number;
  taskCount: number;
  /** Sum of every ceremony + starter-task estimate, for a capacity sanity check. */
  totalPoints: number;
};

function summarize(t: SprintTemplate): SprintTemplateSummary {
  const points =
    t.ceremonies.reduce((sum, c) => sum + (c.estimatePoints ?? 0), 0) +
    t.starterTasks.reduce((sum, s) => sum + (s.estimatePoints ?? 0), 0);
  return {
    slug: t.slug,
    name: t.name,
    description: t.description,
    category: t.category,
    useCases: t.useCases,
    complexity: t.complexity,
    lengthDays: t.lengthDays,
    goalTemplate: t.goalTemplate,
    capacityPoints: t.capacityPoints,
    ceremonyCount: t.ceremonies.length,
    taskCount: t.starterTasks.length,
    totalPoints: points,
  };
}

// Catalog + filter facets for the gallery (and for any agent surface that
// wants to browse before applying). Static data, so no auth is needed —
// same posture as `templates.templateCatalog`.
export function sprintTemplateCatalog(): {
  templates: SprintTemplateSummary[];
  categories: string[];
  complexities: SprintTemplateComplexity[];
  useCases: string[];
} {
  const templates = SPRINT_TEMPLATES.map(summarize);
  const categories = [...new Set(templates.map((t) => t.category))].sort();
  const useCases = [
    ...new Set(templates.flatMap((t) => t.useCases)),
  ].sort();
  return {
    templates,
    categories,
    complexities: ["beginner", "intermediate", "advanced"],
    useCases,
  };
}
