// What an agent did, folded into what a person can read.
//
// A turn's raw stream is not a transcript, it is telemetry: forty tool calls,
// a hundred file reads, a shell command per test file. Drawn one row per frame
// it is unreadable *and* it pushes the conversation off the screen — the room
// stops being a room and becomes a log viewer that occasionally contains
// speech. So this file answers two questions and nothing else:
//
//   1. **What kind of thing is this?** (`classifyStep`) — because "Read file"
//      and "Ran a command" and "Posted a message" are different enough that
//      collapsing them together loses the shape of the work.
//   2. **Which of these are one thing?** (`buildTurnActivity`) — a two-pass
//      collapse, same-kind first and then mixed bursts.
//
// Pure. No React, no Convex, no `Date.now()`. Every rule below is a total
// function of its arguments, which is what makes the collapse testable without
// a DOM — the same discipline `src/lib/buzz/timeline.ts` follows for messages,
// and for the same reason: these rules will be argued about, and an argument
// about a rule that can only be settled by looking at a screenshot is an
// argument nobody wins.
//
// Spec: 02-agents §6.4 (tool classification) and §6.5 (turn segmentation and
// burst collapsing).
//
// ---------------------------------------------------------------------------
// The direction the fold runs, which is the one thing to get right
// ---------------------------------------------------------------------------
//
// `timeline.ts:planSystemGroups` folds **backwards from the newest** message
// and says why: groups are anchored on the end that does not move, so paging
// in older history can only ever be absorbed into a group that already exists
// — it can never split one, re-anchor one, or change a group's identity. A
// fold anchored on the moving edge repartitions the screen every time data
// arrives, which a reader sees as rows rewriting themselves.
//
// The invariant here is the same one and it produces the **opposite**
// direction, because a turn's moving edge is the opposite end. Messages
// prepend (history loads backwards); a run's steps **append** (the agent is
// still working). So the stable end is the oldest step, the fold runs forwards
// from it, and a summary is keyed on its FIRST member. Appending the fortieth
// tool call to a burst leaves the burst's row identity untouched — its count
// goes up, its key does not, and React does not remount a row somebody is
// looking at. Copying the timeline's direction verbatim would have been the
// exact bug that file exists to prevent, wearing the same clothes.

// ---------------------------------------------------------------------------
// What a step is
// ---------------------------------------------------------------------------
//
// Defined here rather than on `ChatTurn`, because a turn deliberately does not
// carry one. The turn record is a room, a start, a sentence and an ending — one
// replaced narration line, never a growing transcript, because the transcript
// IS the room. Steps are a *runtime's* account of its own work, and this
// product has no room-scoped stream of them yet: an agent reports narration
// over `streamTurn` and nothing finer.
//
// So this is the shape such a stream will be read as, and the fold below is
// complete and tested against it. Until something supplies one, the log says so
// — see `activity-log.tsx`, which draws the honest empty state rather than a
// plausible one. A fabricated step list would be believed.

export type ChatTurnStep = {
  /** Stable across restarts of the same step — what makes an emit idempotent. */
  key: string;
  title: string;
  status: "running" | "done" | "failed";
  /** Free text the runtime attached: a path, a command, an error. */
  detail?: string;
  /** The tool this step ran, if it ran one. What classification reads. */
  tool?: string;
  startedAt: number;
  finishedAt?: number;
  /**
   * The ACP session the step belongs to.
   *
   * Absent is ordinary and load-bearing rather than missing data: the opening
   * frames of a turn are emitted before a session resolves (02-agents §6.5), so
   * absent means "not yet", never "unknown forever".
   */
  sessionId?: string | null;
  isError?: boolean;
};

// ---------------------------------------------------------------------------
// §6.4 Classification
// ---------------------------------------------------------------------------

/**
 * What a step *is*, for drawing purposes.
 *
 * Buzz's `AgentActivityRenderClass` minus the two classes our substrate has no
 * frame for (`raw-rail` is the undecoded observer stream, which we do not have
 * because a turn arrives already structured; `suppressed` marks an echoed
 * steer, which is a harness-batching artefact).
 */
export type ActivityRenderClass =
  | "relay-op"
  | "file-edit"
  | "file-read"
  | "skill-read"
  | "image"
  | "shell"
  | "plan"
  | "status"
  | "permission"
  | "error"
  | "generic";

/**
 * Whether the step read something, changed something, or changed who may.
 *
 * Not decoration. It is the only summary of a burst that answers the question
 * a person actually has when forty rows collapse into one: did anything happen
 * that I would want to have been asked about?
 */
export type ActivityTone = "read" | "write" | "admin" | "neutral";

export type ActivityDescriptor = {
  renderClass: ActivityRenderClass;
  tone: ActivityTone;
  /**
   * What two adjacent steps must share to fold. Absent means "never folds with
   * anything", which is not the same as folding on `renderClass` — a status row
   * and a permission prompt are both un-foldable for reasons of their own.
   */
  groupKey?: string;
  /** The three tenses of one label, so a running step never reads as finished. */
  verbs: { running: string; done: string; failed: string };
  /** The object of the sentence: a path, a command, a room name. */
  preview?: string;
};

export type ClassifiedStep = {
  /** Stable row id. Derived from the step key, which the runtime keeps stable. */
  id: string;
  step: ChatTurnStep;
  descriptor: ActivityDescriptor;
  /** `verbs` resolved against `step.status`. */
  label: string;
};

/** Harness-native tools — the ones every ACP runtime has (§6.4 provider 2). */
const DEVELOPER_TOOLS: Record<string, ActivityDescriptor> = {
  shell: {
    renderClass: "shell",
    tone: "write",
    groupKey: "shell",
    verbs: { running: "Running a command", done: "Ran a command", failed: "Command failed" },
  },
  read_file: {
    renderClass: "file-read",
    tone: "read",
    groupKey: "file-read",
    verbs: { running: "Reading a file", done: "Read a file", failed: "Read failed" },
  },
  str_replace: {
    renderClass: "file-edit",
    tone: "write",
    groupKey: "file-edit",
    verbs: { running: "Editing a file", done: "Edited a file", failed: "Edit failed" },
  },
  view_image: {
    renderClass: "image",
    tone: "read",
    groupKey: "image",
    verbs: { running: "Opening an image", done: "Viewed an image", failed: "Image failed" },
  },
  todo: {
    renderClass: "plan",
    tone: "neutral",
    groupKey: "plan",
    verbs: { running: "Updating the plan", done: "Updated the plan", failed: "Plan update failed" },
  },
  stop: {
    renderClass: "status",
    tone: "neutral",
    verbs: { running: "Stopping", done: "Stopped", failed: "Stop failed" },
  },
};

/** Aliases every harness spells differently for the same act. */
const DEVELOPER_TOOL_ALIASES: Record<string, keyof typeof DEVELOPER_TOOLS> = {
  bash: "shell",
  run_command: "shell",
  execute: "shell",
  read: "read_file",
  cat: "read_file",
  edit_file: "str_replace",
  write_file: "str_replace",
  apply_patch: "str_replace",
  update_plan: "todo",
};

/**
 * The nouns this product's own tools act on.
 *
 * Buzz's `BUZZ_CLI_GROUPS` renamed to our vocabulary, because our MCP tools are
 * `<verb>_<object>` over tasks, pages, plans and rooms rather than over Buzz's
 * relay primitives. The set is closed on purpose: a tool whose object is not
 * listed falls through to `generic` and is still drawn, still grouped and still
 * counted — it just is not claimed to be a room operation when nobody knows
 * that it is.
 */
const RELAY_OBJECTS: ReadonlySet<string> = new Set([
  "message", "messages", "channel", "channels", "dm", "dms", "reaction",
  "reactions", "thread", "room", "rooms", "member", "members", "canvas",
  "feed", "task", "tasks", "page", "pages", "doc", "docs", "comment",
  "comments", "sprint", "sprints", "goal", "goals", "plan", "question",
  "decision", "panel", "run", "presence", "note", "notes",
]);

/** Verbs that change who may do what. Called out because a burst hides them. */
const ADMIN_VERBS: ReadonlySet<string> = new Set([
  "add", "remove", "delete", "archive", "unarchive", "grant", "revoke",
  "invite", "attach", "detach", "approve", "assign",
]);

/** Verbs that only look. */
const READ_VERBS: ReadonlySet<string> = new Set([
  "get", "list", "read", "search", "find", "fetch", "show", "describe", "brief",
]);

function normalizeToolName(raw: string | undefined): string {
  return (raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/** `mcp__buzz__create_task` and `buzz.create_task` both end at `create_task`. */
function toolBase(name: string): string {
  const tail = name.split(/__|\./).filter(Boolean).pop() ?? "";
  return tail;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * A step, classified. Ordered providers, first match wins (§6.4).
 *
 * The order is the specificity order and it matters at exactly one place:
 * `load_skill` is checked before the harness table, because a skill read is a
 * file read wearing a different meaning — the file is a playbook the agent
 * chose to follow, which is a fact about its behaviour rather than about the
 * repository.
 */
export function classifyStep(step: ChatTurnStep): ClassifiedStep {
  const descriptor = describe(step);
  const failed = step.status === "failed" || step.isError === true;

  // A failure is re-classed rather than merely styled, and that is a grouping
  // decision more than a colour one: `error` is not in the eligible set, so a
  // failed step both stands alone and BREAKS the burst around it. The step you
  // would want to have seen is never the one folded into "Ran 40 tool calls".
  const shown: ActivityDescriptor = failed
    ? { ...descriptor, renderClass: "error", tone: descriptor.tone, groupKey: undefined }
    : descriptor;

  return {
    id: `step:${step.key}`,
    step,
    descriptor: shown,
    label: failed
      ? shown.verbs.failed
      : step.status === "running"
        ? shown.verbs.running
        : shown.verbs.done,
  };
}

function describe(step: ChatTurnStep): ActivityDescriptor {
  const name = normalizeToolName(step.tool);
  const base = toolBase(name);
  const title = step.title?.trim() ?? "";
  const detail = step.detail?.trim() ?? "";

  // 1. Skills.
  if (base === "load_skill" || base === "read_skill" || name.endsWith("skill")) {
    // A slug with a slash in it is a *supporting file* of a skill rather than
    // the skill itself — the distinction Buzz draws, and it is worth drawing:
    // "read the playbook" and "read one of the playbook's attachments" are
    // different amounts of intent.
    const ref = detail || title;
    const supporting = ref.includes("/");
    return {
      renderClass: "skill-read",
      tone: "read",
      groupKey: "skill-read",
      preview: ref || undefined,
      verbs: supporting
        ? { running: "Reading a skill file", done: "Read a skill file", failed: "Skill file read failed" }
        : { running: "Reading a skill", done: "Read a skill", failed: "Skill read failed" },
    };
  }

  // 2. The harness's own tools.
  const developer =
    DEVELOPER_TOOLS[base] ?? DEVELOPER_TOOLS[DEVELOPER_TOOL_ALIASES[base] ?? ""];
  if (developer) {
    return { ...developer, preview: detail || title || undefined };
  }

  // 3. This product's tools: `<verb>_<object>`.
  const parts = base.split("_");
  if (parts.length >= 2) {
    const verb = parts[0];
    const object = parts.slice(1).join("_");
    if (RELAY_OBJECTS.has(object) || RELAY_OBJECTS.has(parts[parts.length - 1])) {
      const tone: ActivityTone = ADMIN_VERBS.has(verb)
        ? "admin"
        : READ_VERBS.has(verb)
          ? "read"
          : "write";
      const noun = object.replace(/_/g, " ");
      return {
        renderClass: "relay-op",
        tone,
        groupKey: "relay-op",
        preview: detail || title || undefined,
        verbs: {
          running: `${titleCase(verb)}ing ${noun}`,
          done: `${titleCase(verb)} ${noun}`,
          failed: `${titleCase(verb)} ${noun} failed`,
        },
      };
    }
  }

  // 4. Anything else. Still drawn, still grouped, never guessed at: the title
  // the runtime supplied is used verbatim rather than a manufactured sentence.
  const fallback = title || (base ? base.replace(/_/g, " ") : "Worked");
  return {
    renderClass: "generic",
    tone: "neutral",
    groupKey: "generic",
    preview: detail || undefined,
    verbs: { running: fallback, done: fallback, failed: `${fallback} failed` },
  };
}

export const RENDER_CLASS_LABEL: Record<ActivityRenderClass, string> = {
  "relay-op": "Room op",
  "file-edit": "File edit",
  "file-read": "File read",
  "skill-read": "Skill read",
  image: "Image",
  shell: "Shell command",
  plan: "Plan",
  status: "Status",
  permission: "Permission",
  error: "Error",
  generic: "Tool",
};

// ---------------------------------------------------------------------------
// §6.5 Collapsing
// ---------------------------------------------------------------------------

/**
 * What may be folded away.
 *
 * The absences are the specification. A **failed** step, a **permission**
 * prompt and a **status** row are the three things a person scanning a burst is
 * scanning *for* — they are the intervention points, the places where the work
 * either needs them or went wrong. Folding one into "Ran 40 tool calls" would
 * be hiding the only rows that were worth drawing.
 */
export const GROUPING_ELIGIBLE_RENDER_CLASSES: ReadonlySet<ActivityRenderClass> =
  new Set(["file-read", "skill-read", "shell", "relay-op", "file-edit", "image", "plan", "generic"]);

/** Two adjacent segments make a mixed burst (§6.5). */
export const MIXED_RUN_MINIMUM_SEGMENTS = 2;

/**
 * How long a same-kind run must be before it collapses.
 *
 * Two for an edit, three for everything else, and the asymmetry is deliberate:
 * two file edits are a change with two parts and a person wants to know it
 * touched two files, not to read both rows; two file reads are an agent
 * orienting itself, and there is no fact in the second row that the first did
 * not already carry.
 */
export function minimumSummaryRunLength(groupKey: string): number {
  return groupKey === "file-edit" ? 2 : 3;
}

export type ActivitySegment =
  | { kind: "step"; id: string; item: ClassifiedStep }
  | {
      kind: "summary";
      id: string;
      variant: "same-kind" | "mixed";
      label: string;
      /** Leaves, always — never nested summaries. See `groupMixedRuns`. */
      children: ClassifiedStep[];
      /** The dominant tone among the children: `admin` wins, then `write`. */
      tone: ActivityTone;
    };

function eligible(item: ClassifiedStep): boolean {
  return (
    item.descriptor.groupKey !== undefined &&
    GROUPING_ELIGIBLE_RENDER_CLASSES.has(item.descriptor.renderClass)
  );
}

/**
 * The strongest thing that happened inside a fold.
 *
 * A summary that reported the *average* of its children would say "read" about
 * a burst that removed somebody from a room. The rule is deliberately
 * pessimistic in one direction only.
 */
function dominantTone(children: readonly ClassifiedStep[]): ActivityTone {
  let best: ActivityTone = "neutral";
  for (const child of children) {
    const tone = child.descriptor.tone;
    if (tone === "admin") return "admin";
    if (tone === "write") best = "write";
    else if (tone === "read" && best === "neutral") best = "read";
  }
  return best;
}

/** `Edited 3 files`, `Read 5 files`, `Ran 8 commands`, `Plan ×4`. */
function sameKindLabel(groupKey: string, children: readonly ClassifiedStep[]): string {
  const n = children.length;
  switch (groupKey) {
    case "file-edit":
      return `Edited ${n} files`;
    case "file-read":
      return `Read ${n} files`;
    case "skill-read":
      return `Read ${n} skills`;
    case "shell":
      return `Ran ${n} commands`;
    case "relay-op":
      return `Ran ${n} room ops`;
    case "image":
      return `Viewed ${n} images`;
    default:
      // The generic form keeps the run's own words rather than inventing a
      // plural for a tool nobody has a noun for.
      return `${children[0].label} ×${n}`;
  }
}

/**
 * Pass 1 — adjacent runs of the same kind.
 *
 * Forwards from the oldest, for the reason at the top of this file. The
 * summary's id is its FIRST child's, so appending to a run does not change the
 * identity of a row already on screen.
 */
export function groupSameKindSegments(items: readonly ClassifiedStep[]): ActivitySegment[] {
  const out: ActivitySegment[] = [];
  let run: ClassifiedStep[] = [];
  let runKey: string | null = null;

  const flush = (): void => {
    if (run.length === 0) return;
    const key = runKey ?? "";
    if (key && run.length >= minimumSummaryRunLength(key)) {
      out.push({
        kind: "summary",
        id: `summary:${key}:${run[0].id}`,
        variant: "same-kind",
        label: sameKindLabel(key, run),
        children: run,
        tone: dominantTone(run),
      });
    } else {
      for (const item of run) out.push({ kind: "step", id: item.id, item });
    }
    run = [];
    runKey = null;
  };

  for (const item of items) {
    const key = eligible(item) ? (item.descriptor.groupKey ?? null) : null;
    if (key === null) {
      flush();
      out.push({ kind: "step", id: item.id, item });
      continue;
    }
    if (runKey !== null && runKey !== key) flush();
    runKey = key;
    run.push(item);
  }
  flush();
  return out;
}

/**
 * Pass 2 — a mixed burst.
 *
 * Anything eligible that survived pass 1, plus pass-1 summaries, collapse into
 * one row when two or more sit adjacent. Mixed summaries never re-enter, so
 * the fold cannot nest.
 *
 * **Children are flattened to leaves.** Expanding "Ran 16 tool calls" into
 * "Ran 12 commands" and four rows would make the reader open two things to see
 * one thing — a summary of summaries is a table of contents for a paragraph.
 */
export function groupMixedRuns(segments: readonly ActivitySegment[]): ActivitySegment[] {
  const participates = (segment: ActivitySegment): boolean =>
    segment.kind === "summary"
      ? segment.variant === "same-kind"
      : eligible(segment.item);

  const out: ActivitySegment[] = [];
  let run: ActivitySegment[] = [];

  const flush = (): void => {
    if (run.length === 0) return;
    if (run.length >= MIXED_RUN_MINIMUM_SEGMENTS) {
      const children = run.flatMap((segment) =>
        segment.kind === "summary" ? segment.children : [segment.item],
      );
      out.push({
        kind: "summary",
        id: `burst:${run[0].id}`,
        variant: "mixed",
        label: `Ran ${children.length} tool calls`,
        children,
        tone: dominantTone(children),
      });
    } else {
      out.push(...run);
    }
    run = [];
  };

  for (const segment of segments) {
    if (participates(segment)) {
      run.push(segment);
      continue;
    }
    flush();
    out.push(segment);
  }
  flush();
  return out;
}

/** The two passes, composed. The only order they may run in. */
export function collapseActivity(items: readonly ClassifiedStep[]): ActivitySegment[] {
  return groupMixedRuns(groupSameKindSegments(items));
}

// ---------------------------------------------------------------------------
// §6.5 Session runs
// ---------------------------------------------------------------------------

export type ActivityRun = {
  /** `"unknown"` when the whole stream is session-less. */
  sessionId: string;
  /** React key. The run's first step, which is stable across prepends. */
  key: string;
  segments: ActivitySegment[];
};

/**
 * Contiguous runs of one session.
 *
 * One rule earns its place, and it is not obvious until it is wrong: the real
 * wire order of a turn's first frames is `turn started (no session)` →
 * `session/new (no session)` → `session resolved (sess-X)`. Grouping naively
 * puts those first frames in a run of their own, above the boundary marker for
 * the session they belong to — so a fresh turn draws a session divider *under*
 * its own opening. **Leading session-less steps are deferred and prepended to
 * the first run that resolves a session.**
 *
 * Mid-stream session-less steps attribute to the run already open (the session
 * did not end, a frame merely arrived without the tag). A stream with no
 * session anywhere is one run keyed `"unknown"` rather than N runs of one.
 */
export function splitIntoSessionRuns(
  items: readonly ClassifiedStep[],
): { sessionId: string; items: ClassifiedStep[] }[] {
  const runs: { sessionId: string; items: ClassifiedStep[] }[] = [];
  let leading: ClassifiedStep[] = [];

  for (const item of items) {
    const sessionId = item.step.sessionId ?? null;
    if (sessionId === null) {
      if (runs.length === 0) leading.push(item);
      else runs[runs.length - 1].items.push(item);
      continue;
    }
    const open = runs[runs.length - 1];
    if (open && open.sessionId === sessionId) {
      open.items.push(item);
      continue;
    }
    const started = { sessionId, items: [...leading, item] };
    leading = [];
    runs.push(started);
  }

  if (leading.length > 0) runs.push({ sessionId: "unknown", items: leading });
  return runs;
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * A turn's steps → the rows a person reads. The one function a surface calls.
 *
 * Everything above is exported so it can be tested in isolation, but a
 * component drawing an activity log should call this: it is the only place
 * that knows classification runs before splitting and splitting before
 * collapsing, and getting that order wrong folds across a session boundary.
 */
export function buildTurnActivity(
  steps: readonly ChatTurnStep[] | undefined,
): ActivityRun[] {
  const classified = (steps ?? []).map(classifyStep);
  return splitIntoSessionRuns(classified).map((run) => ({
    sessionId: run.sessionId,
    key: run.items[0]?.id ?? run.sessionId,
    segments: collapseActivity(run.items),
  }));
}

/** How many rows a turn would draw. What the "N steps" affordance counts. */
export function countActivityRows(runs: readonly ActivityRun[]): number {
  return runs.reduce((total, run) => total + run.segments.length, 0);
}
