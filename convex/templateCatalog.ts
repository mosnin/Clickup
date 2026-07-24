// Template Center catalog. Like `templates.ts` (LIST_TEMPLATES) and
// `skills.ts` (BUILTIN_SKILLS), this is a code catalog, not a table: the
// templates ship with the app, are reviewable in diffs, and need no CMS.
//
// Where `templates.ts` only knows how to seed a list, this catalog covers
// every entity a person actually starts from — a list, a single task, a
// doc, a whiteboard, or a saved view preset — so "start from a template"
// is one surface instead of five. Applying an entry always goes through the
// product's real write paths (see `templates.ts`), never a private one.
//
// Nothing here touches the database, so this module stays pure and is unit
// testable without a Convex context.

export type TemplateEntityType =
  | "list"
  | "task"
  | "doc"
  | "whiteboard"
  | "view";

export type TemplateComplexity = "beginner" | "intermediate" | "advanced";

export const TEMPLATE_CATEGORIES = [
  "Marketing",
  "Engineering",
  "Product",
  "Design",
  "Sales",
  "Support",
  "Operations",
  "HR",
  "Finance",
  "Agency",
  "Education",
  "Personal",
] as const;

export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const TEMPLATE_ENTITY_TYPES: TemplateEntityType[] = [
  "list",
  "task",
  "doc",
  "whiteboard",
  "view",
];

export const TEMPLATE_COMPLEXITIES: TemplateComplexity[] = [
  "beginner",
  "intermediate",
  "advanced",
];

export type TaskPriority = "urgent" | "high" | "normal" | "low";

// ── Payload shapes ──────────────────────────────────────────────────────

export type CatalogStatus = {
  name: string;
  color: string;
  category: "open" | "in_progress" | "complete" | "closed";
};

export type CatalogField =
  | { name: string; type: "text" | "number" | "date" | "checkbox" }
  | {
      name: string;
      type: "dropdown";
      options: { label: string; color?: string }[];
    };

export type CatalogSeedTask = {
  title: string;
  description?: string;
  /** Index into the template's status list (clamped). Defaults to 0. */
  statusIndex?: number;
  priority?: TaskPriority;
  /** Acceptance criteria, materialised as an unchecked checklist. */
  checklist?: string[];
  estimatePoints?: number;
  /** Due date, in days from the moment the template is applied. */
  dueInDays?: number;
};

export type ListPayload = {
  color?: string;
  statuses?: CatalogStatus[];
  fields?: CatalogField[];
  tasks?: CatalogSeedTask[];
};

export type TaskPayload = {
  title: string;
  description: string;
  priority?: TaskPriority;
  checklist: string[];
  estimatePoints?: number;
  /** Raises the human-approval gate on the created task. */
  requiresApproval?: boolean;
  dueInDays?: number;
  /** Created as real child tasks under the main one. */
  subtasks?: string[];
};

/**
 * Compact block DSL for doc bodies. `docContent()` turns it into the
 * Tiptap/ProseMirror JSON the `docs.content` column stores — authoring 400
 * lines of raw node objects by hand would be unreadable and easy to get
 * subtly wrong.
 */
export type DocBlock =
  | { h: string; level?: 1 | 2 | 3 }
  | { p: string }
  | { ul: string[] }
  | { ol: string[] }
  | { quote: string }
  | { hr: true };

export type DocPayload = {
  title: string;
  body: DocBlock[];
};

export type BoardFrame = {
  title: string;
  /** One line of instruction rendered as text inside the frame. */
  prompt: string;
  /** Sticky notes seeded inside the frame. */
  notes?: string[];
};

export type WhiteboardPayload = {
  title: string;
  frames: BoardFrame[];
};

export type SavedViewKind =
  | "overview"
  | "list"
  | "board"
  | "table"
  | "calendar"
  | "gantt"
  | "timeline"
  | "workload"
  | "network";

export type ViewPayload = {
  name: string;
  view: SavedViewKind;
  /**
   * Comma-joined filter flags, sorted — the exact format
   * `savedViews.flags` and the list page's `?f=` param use. Valid flags:
   * active, approval, blocked, mine, unassigned.
   */
  flags?: string;
  priority?: TaskPriority;
  /** One line explaining what the preset answers, shown on the card. */
  answers: string;
};

export type CatalogTemplate = {
  slug: string;
  name: string;
  description: string;
  category: TemplateCategory;
  useCases: string[];
  complexity: TemplateComplexity;
} & (
  | { entityType: "list"; list: ListPayload }
  | { entityType: "task"; task: TaskPayload }
  | { entityType: "doc"; doc: DocPayload }
  | { entityType: "whiteboard"; whiteboard: WhiteboardPayload }
  | { entityType: "view"; view: ViewPayload }
);

// ── Tiptap JSON builder ─────────────────────────────────────────────────

type ProseNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: ProseNode[];
  text?: string;
};

function textNode(text: string): ProseNode[] {
  // Tiptap refuses a text node with an empty string; an attribute-less
  // paragraph is the correct representation of a blank line.
  return text ? [{ type: "text", text }] : [];
}

function listItems(items: string[]): ProseNode[] {
  return items.map((item) => ({
    type: "listItem",
    content: [{ type: "paragraph", content: textNode(item) }],
  }));
}

export function docContent(blocks: DocBlock[]): ProseNode {
  const content: ProseNode[] = [];
  for (const block of blocks) {
    if ("h" in block) {
      content.push({
        type: "heading",
        attrs: { level: block.level ?? 2 },
        content: textNode(block.h),
      });
    } else if ("p" in block) {
      content.push({ type: "paragraph", content: textNode(block.p) });
    } else if ("ul" in block) {
      content.push({ type: "bulletList", content: listItems(block.ul) });
    } else if ("ol" in block) {
      content.push({ type: "orderedList", content: listItems(block.ol) });
    } else if ("quote" in block) {
      content.push({
        type: "blockquote",
        content: [{ type: "paragraph", content: textNode(block.quote) }],
      });
    } else {
      content.push({ type: "horizontalRule" });
    }
  }
  // A doc always ends on an empty paragraph so there's somewhere to type.
  content.push({ type: "paragraph" });
  return { type: "doc", content };
}

// ── tldraw snapshot builder ─────────────────────────────────────────────

// Serialized tldraw schema for the version we ship (see package.json).
// tldraw migrates a snapshot forward from whatever sequence numbers it
// carries, so pinning today's numbers is the correct, forward-compatible
// thing to record; the whiteboard canvas additionally falls back to a blank
// board if a snapshot ever fails to load.
const TLDRAW_SCHEMA = {
  schemaVersion: 2,
  sequences: {
    "com.tldraw.store": 4,
    "com.tldraw.asset": 1,
    "com.tldraw.camera": 1,
    "com.tldraw.document": 2,
    "com.tldraw.instance": 25,
    "com.tldraw.instance_page_state": 5,
    "com.tldraw.page": 1,
    "com.tldraw.instance_presence": 6,
    "com.tldraw.pointer": 1,
    "com.tldraw.shape": 4,
    "com.tldraw.asset.bookmark": 2,
    "com.tldraw.asset.image": 5,
    "com.tldraw.asset.video": 5,
    "com.tldraw.shape.arrow": 6,
    "com.tldraw.shape.bookmark": 2,
    "com.tldraw.shape.draw": 2,
    "com.tldraw.shape.embed": 4,
    "com.tldraw.shape.frame": 1,
    "com.tldraw.shape.geo": 10,
    "com.tldraw.shape.group": 0,
    "com.tldraw.shape.highlight": 1,
    "com.tldraw.shape.image": 5,
    "com.tldraw.shape.line": 5,
    "com.tldraw.shape.note": 9,
    "com.tldraw.shape.text": 3,
    "com.tldraw.shape.video": 4,
    "com.tldraw.binding.arrow": 1,
  },
} as const;

const BASE62 =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Fractional index keys: head char "a" (one integer digit) plus a base62
// digit, which sorts lexicographically in the order we emit them.
function indexKey(n: number): string {
  return `a${BASE62[Math.min(n, BASE62.length - 1)]}`;
}

const FRAME_WIDTH = 420;
const FRAME_GAP = 64;
const NOTE_PITCH = 216;
const NOTES_TOP = 104;

// tldraw's rich text is itself Tiptap JSON.
function richText(text: string) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: textNode(text) }],
  };
}

const NOTE_COLORS = ["yellow", "light-blue", "light-green", "violet"] as const;

/**
 * Builds a real tldraw store snapshot: one titled frame per section, a text
 * prompt at the top of each, and seeded sticky notes underneath. Pure JSON,
 * so it can be produced inside a Convex mutation (tldraw itself never runs
 * on the server). Record shapes match what `editor.store.getSnapshot()`
 * emits, verified against the installed tldraw validators.
 */
export function boardSnapshot(frames: BoardFrame[]): unknown {
  const store: Record<string, unknown> = {
    "document:document": {
      gridSize: 10,
      name: "",
      meta: {},
      id: "document:document",
      typeName: "document",
    },
    "page:page": {
      meta: {},
      id: "page:page",
      name: "Page 1",
      index: "a1",
      typeName: "page",
    },
  };

  frames.forEach((frame, f) => {
    const frameId = `shape:frame${f}`;
    const notes = frame.notes ?? [];
    const height = Math.max(360, NOTES_TOP + notes.length * NOTE_PITCH + 32);
    store[frameId] = {
      x: f * (FRAME_WIDTH + FRAME_GAP),
      y: 0,
      rotation: 0,
      isLocked: false,
      opacity: 1,
      meta: {},
      id: frameId,
      type: "frame",
      parentId: "page:page",
      index: indexKey(f),
      props: {
        w: FRAME_WIDTH,
        h: height,
        name: frame.title,
        color: "black",
      },
      typeName: "shape",
    };

    const promptId = `shape:prompt${f}`;
    store[promptId] = {
      x: 24,
      y: 24,
      rotation: 0,
      isLocked: false,
      opacity: 1,
      meta: {},
      id: promptId,
      type: "text",
      parentId: frameId,
      index: indexKey(0),
      props: {
        richText: richText(frame.prompt),
        color: "black",
        size: "s",
        w: FRAME_WIDTH - 48,
        font: "sans",
        textAlign: "start",
        autoSize: false,
        scale: 1,
      },
      typeName: "shape",
    };

    notes.forEach((note, n) => {
      const noteId = `shape:note${f}_${n}`;
      store[noteId] = {
        x: 24,
        y: NOTES_TOP + n * NOTE_PITCH,
        rotation: 0,
        isLocked: false,
        opacity: 1,
        meta: {},
        id: noteId,
        type: "note",
        parentId: frameId,
        index: indexKey(n + 1),
        props: {
          richText: richText(note),
          color: NOTE_COLORS[n % NOTE_COLORS.length],
          size: "s",
          font: "sans",
          align: "middle",
          verticalAlign: "middle",
          growY: 0,
          url: "",
          fontSizeAdjustment: 0,
          labelColor: "black",
          scale: 1,
        },
        typeName: "shape",
      };
    });
  });

  return { store, schema: TLDRAW_SCHEMA };
}

// ── Shared status sets ──────────────────────────────────────────────────

const PIPELINE = (
  names: [string, string, string, string],
): CatalogStatus[] => [
  { name: names[0], color: "#c9ccd4", category: "open" },
  { name: names[1], color: "#a9c6f2", category: "in_progress" },
  { name: names[2], color: "#f2d491", category: "in_progress" },
  { name: names[3], color: "#a9dcbd", category: "complete" },
];

// ── The catalog ─────────────────────────────────────────────────────────

export const TEMPLATE_CATALOG: CatalogTemplate[] = [
  // ── Lists ─────────────────────────────────────────────────────────────
  {
    slug: "product-launch-runway",
    name: "Product launch runway",
    description:
      "Everything a launch needs in one list: positioning, assets, enablement, and the day-of runbook, staged from brief to shipped.",
    entityType: "list",
    category: "Marketing",
    useCases: ["Launch", "Go-to-market", "Cross-functional"],
    complexity: "intermediate",
    list: {
      color: "#f2c291",
      statuses: [
        { name: "Brief", color: "#c9ccd4", category: "open" },
        { name: "In build", color: "#a9c6f2", category: "in_progress" },
        { name: "In review", color: "#f2d491", category: "in_progress" },
        { name: "Ready", color: "#c6bcf2", category: "in_progress" },
        { name: "Shipped", color: "#a9dcbd", category: "complete" },
        { name: "Cut", color: "#c2c2ca", category: "closed" },
      ],
      fields: [
        {
          name: "Workstream",
          type: "dropdown",
          options: [
            { label: "Positioning", color: "#c6bcf2" },
            { label: "Content", color: "#f2d491" },
            { label: "Product", color: "#a9c6f2" },
            { label: "Enablement", color: "#a9dcbd" },
          ],
        },
        { name: "Launch date", type: "date" },
        { name: "Tier 1 asset", type: "checkbox" },
      ],
      tasks: [
        {
          title: "Write the launch narrative",
          description:
            "One page: who it is for, the problem it removes, why now, and the sentence a customer would repeat.",
          priority: "high",
          checklist: [
            "Audience and their current workaround",
            "The one-sentence promise",
            "Three proof points",
            "Reviewed with product and sales",
          ],
          dueInDays: 7,
        },
        {
          title: "Lock scope and cut list",
          description:
            "Agree what ships on day one and what explicitly does not. Publish the cut list so nobody relitigates it in launch week.",
          priority: "high",
          dueInDays: 5,
        },
        {
          title: "Produce the launch page",
          statusIndex: 1,
          checklist: [
            "Hero and subhead approved",
            "Screenshots current",
            "Pricing block accurate",
            "Metadata and canonical set",
          ],
          dueInDays: 14,
        },
        {
          title: "Record the two-minute demo",
          statusIndex: 1,
          dueInDays: 12,
        },
        {
          title: "Brief sales and support",
          description:
            "Objection handling, pricing edges, and the three questions support will get on day one.",
          statusIndex: 1,
          dueInDays: 16,
        },
        {
          title: "Day-of runbook",
          description:
            "Ordered checklist with owners and times: publish, announce, monitor, respond.",
          checklist: [
            "Publish page and docs",
            "Send announcement email",
            "Post to social and community",
            "Watch error rates for two hours",
            "Post-launch check-in scheduled",
          ],
          dueInDays: 18,
        },
      ],
    },
  },
  {
    slug: "editorial-calendar",
    name: "Editorial calendar",
    description:
      "A publishing pipeline with channel, target date, and word count, so the calendar view answers what ships this week.",
    entityType: "list",
    category: "Marketing",
    useCases: ["Content", "Publishing", "Planning"],
    complexity: "beginner",
    list: {
      color: "#f2d491",
      statuses: [
        { name: "Idea", color: "#c9ccd4", category: "open" },
        { name: "Outlined", color: "#c6bcf2", category: "open" },
        { name: "Drafting", color: "#a9c6f2", category: "in_progress" },
        { name: "Editing", color: "#f2d491", category: "in_progress" },
        { name: "Published", color: "#a9dcbd", category: "complete" },
      ],
      fields: [
        {
          name: "Channel",
          type: "dropdown",
          options: [
            { label: "Blog", color: "#a9c6f2" },
            { label: "Newsletter", color: "#f2d491" },
            { label: "Social", color: "#a9dcbd" },
            { label: "Video", color: "#c6bcf2" },
          ],
        },
        { name: "Publish date", type: "date" },
        { name: "Target words", type: "number" },
        { name: "Primary keyword", type: "text" },
      ],
      tasks: [
        {
          title: "Quarterly theme and pillar topics",
          description:
            "Pick three pillars. Everything published this quarter should ladder up to one of them.",
          priority: "high",
        },
        { title: "Customer story: onboarding in a day", statusIndex: 1 },
        { title: "How we think about agent governance", statusIndex: 2 },
        { title: "Monthly newsletter: what shipped", statusIndex: 2 },
      ],
    },
  },
  {
    slug: "seo-content-program",
    name: "SEO content program",
    description:
      "Keyword clusters through brief, draft, publish, and refresh — with the metrics that decide what gets rewritten.",
    entityType: "list",
    category: "Marketing",
    useCases: ["Content", "Growth", "Reporting"],
    complexity: "advanced",
    list: {
      color: "#a9dcbd",
      statuses: [
        { name: "Researching", color: "#c9ccd4", category: "open" },
        { name: "Briefed", color: "#c6bcf2", category: "open" },
        { name: "Writing", color: "#a9c6f2", category: "in_progress" },
        { name: "Live", color: "#a9dcbd", category: "complete" },
        { name: "Needs refresh", color: "#f2d491", category: "in_progress" },
      ],
      fields: [
        { name: "Target keyword", type: "text" },
        { name: "Monthly volume", type: "number" },
        {
          name: "Intent",
          type: "dropdown",
          options: [
            { label: "Informational", color: "#a9c6f2" },
            { label: "Comparison", color: "#f2d491" },
            { label: "Transactional", color: "#a9dcbd" },
          ],
        },
        { name: "Internal links done", type: "checkbox" },
      ],
      tasks: [
        {
          title: "Build the keyword map",
          description:
            "Cluster keywords by intent, map each cluster to one page, and mark which clusters we already cover.",
          priority: "high",
          checklist: [
            "Export current rankings",
            "Cluster by intent",
            "Flag cannibalisation",
            "Pick this quarter's five clusters",
          ],
        },
        {
          title: "Write the brief template",
          description:
            "Every brief carries the keyword, the intent, the questions to answer, and the internal links to include.",
        },
        {
          title: "Audit the ten highest-traffic pages",
          statusIndex: 4,
        },
      ],
    },
  },
  {
    slug: "bug-triage",
    name: "Bug triage",
    description:
      "Inbound defects with severity, affected area, and reproduction state — triaged daily, closed with a cause.",
    entityType: "list",
    category: "Engineering",
    useCases: ["Quality", "Support", "Maintenance"],
    complexity: "beginner",
    list: {
      color: "#f2a9a9",
      statuses: [
        { name: "Reported", color: "#c9ccd4", category: "open" },
        { name: "Triaged", color: "#c6bcf2", category: "open" },
        { name: "Fixing", color: "#a9c6f2", category: "in_progress" },
        { name: "Verifying", color: "#f2d491", category: "in_progress" },
        { name: "Fixed", color: "#a9dcbd", category: "complete" },
        { name: "Won't fix", color: "#c2c2ca", category: "closed" },
      ],
      fields: [
        {
          name: "Severity",
          type: "dropdown",
          options: [
            { label: "S1 outage", color: "#f2a9a9" },
            { label: "S2 major", color: "#f2c291" },
            { label: "S3 minor", color: "#f2d491" },
            { label: "S4 cosmetic", color: "#c9ccd4" },
          ],
        },
        { name: "Area", type: "text" },
        { name: "Reproducible", type: "checkbox" },
        { name: "First seen", type: "date" },
      ],
      tasks: [
        {
          title: "Agree the severity rubric",
          description:
            "Write down what S1 through S4 mean in this product so triage is not a debate every morning.",
          priority: "high",
        },
        {
          title: "Daily triage rotation",
          description:
            "One person owns the untriaged queue each day: reproduce, set severity, assign or close with a reason.",
        },
      ],
    },
  },
  {
    slug: "engineering-backlog",
    name: "Engineering backlog",
    description:
      "A sprint-ready backlog: estimate points, definition of ready, and a review column that actually blocks done.",
    entityType: "list",
    category: "Engineering",
    useCases: ["Sprints", "Delivery", "Planning"],
    complexity: "intermediate",
    list: {
      color: "#c6bcf2",
      statuses: [
        { name: "Backlog", color: "#c9ccd4", category: "open" },
        { name: "Ready", color: "#c6bcf2", category: "open" },
        { name: "In progress", color: "#a9c6f2", category: "in_progress" },
        { name: "In review", color: "#f2d491", category: "in_progress" },
        { name: "Done", color: "#a9dcbd", category: "complete" },
      ],
      fields: [
        { name: "Story points", type: "number" },
        {
          name: "Type",
          type: "dropdown",
          options: [
            { label: "Feature", color: "#a9c6f2" },
            { label: "Bug", color: "#f2a9a9" },
            { label: "Chore", color: "#c9ccd4" },
            { label: "Spike", color: "#c6bcf2" },
          ],
        },
        { name: "Needs design", type: "checkbox" },
      ],
      tasks: [
        {
          title: "Write the definition of ready",
          description:
            "A task is ready when it has acceptance criteria, an estimate, and no unresolved design question.",
          statusIndex: 1,
          priority: "high",
        },
        {
          title: "Write the definition of done",
          description:
            "Merged, tested, documented, and observable. Anything else is still in progress.",
          statusIndex: 1,
        },
        {
          title: "Groom the backlog to two sprints deep",
          statusIndex: 0,
          estimatePoints: 3,
        },
      ],
    },
  },
  {
    slug: "incident-response",
    name: "Incident response",
    description:
      "Live incidents with severity, start time, and customer impact, ending in a postmortem task nobody can skip.",
    entityType: "list",
    category: "Engineering",
    useCases: ["Reliability", "On-call", "Postmortem"],
    complexity: "advanced",
    list: {
      color: "#f2a9a9",
      statuses: [
        { name: "Detected", color: "#f2a9a9", category: "open" },
        { name: "Mitigating", color: "#f2c291", category: "in_progress" },
        { name: "Monitoring", color: "#f2d491", category: "in_progress" },
        { name: "Postmortem", color: "#c6bcf2", category: "in_progress" },
        { name: "Closed", color: "#a9dcbd", category: "complete" },
      ],
      fields: [
        {
          name: "Severity",
          type: "dropdown",
          options: [
            { label: "SEV1", color: "#f2a9a9" },
            { label: "SEV2", color: "#f2c291" },
            { label: "SEV3", color: "#f2d491" },
          ],
        },
        { name: "Detected at", type: "date" },
        { name: "Customers affected", type: "number" },
        { name: "Status page updated", type: "checkbox" },
      ],
      tasks: [
        {
          title: "Publish the on-call runbook",
          description:
            "Who declares an incident, how to page, where the incident channel lives, and who talks to customers.",
          priority: "urgent",
          checklist: [
            "Escalation ladder with names",
            "Paging instructions",
            "Status page access confirmed",
            "Customer comms templates",
          ],
        },
        {
          title: "Set the postmortem rule",
          description:
            "Every SEV1 and SEV2 gets a blameless postmortem within five working days, with owned action items.",
        },
      ],
    },
  },
  {
    slug: "feature-intake",
    name: "Feature intake and discovery",
    description:
      "One front door for feature requests: source, evidence, and a discovery gate before anything reaches the backlog.",
    entityType: "list",
    category: "Product",
    useCases: ["Discovery", "Prioritisation", "Customer feedback"],
    complexity: "intermediate",
    list: {
      color: "#a9c6f2",
      statuses: [
        { name: "Inbox", color: "#c9ccd4", category: "open" },
        { name: "Exploring", color: "#a9c6f2", category: "in_progress" },
        { name: "Validated", color: "#c6bcf2", category: "in_progress" },
        { name: "Accepted", color: "#a9dcbd", category: "complete" },
        { name: "Declined", color: "#c2c2ca", category: "closed" },
      ],
      fields: [
        {
          name: "Source",
          type: "dropdown",
          options: [
            { label: "Customer", color: "#a9c6f2" },
            { label: "Sales", color: "#f2d491" },
            { label: "Support", color: "#f2c291" },
            { label: "Internal", color: "#c9ccd4" },
          ],
        },
        { name: "Requests logged", type: "number" },
        { name: "Revenue at stake", type: "number" },
        { name: "Talked to a customer", type: "checkbox" },
      ],
      tasks: [
        {
          title: "Define the intake rules",
          description:
            "What a request must include to enter the queue, and who reviews the inbox each week.",
          priority: "high",
        },
        {
          title: "Weekly discovery review",
          description:
            "Thirty minutes: read the inbox, merge duplicates, decline politely, promote at most two items.",
        },
        {
          title: "Interview five customers about the top request",
          statusIndex: 1,
          checklist: [
            "Recruit five users who asked",
            "Ask about the workaround, not the feature",
            "Write up the pattern",
            "Decide: build, defer, or decline",
          ],
        },
      ],
    },
  },
  {
    slug: "customer-feedback-loop",
    name: "Customer feedback loop",
    description:
      "Capture verbatim feedback, tag the theme, and close the loop with the person who raised it.",
    entityType: "list",
    category: "Product",
    useCases: ["Research", "Customer feedback", "Retention"],
    complexity: "beginner",
    list: {
      color: "#c6bcf2",
      statuses: [
        { name: "Captured", color: "#c9ccd4", category: "open" },
        { name: "Themed", color: "#c6bcf2", category: "in_progress" },
        { name: "Acted on", color: "#a9c6f2", category: "in_progress" },
        { name: "Looped back", color: "#a9dcbd", category: "complete" },
      ],
      fields: [
        {
          name: "Theme",
          type: "dropdown",
          options: [
            { label: "Onboarding", color: "#a9c6f2" },
            { label: "Performance", color: "#f2c291" },
            { label: "Pricing", color: "#f2d491" },
            { label: "Missing capability", color: "#c6bcf2" },
          ],
        },
        { name: "Account", type: "text" },
        { name: "Told them what changed", type: "checkbox" },
      ],
      tasks: [
        {
          title: "Set the capture habit",
          description:
            "Anyone who hears feedback logs it here verbatim within a day, with the account and the exact words.",
        },
        {
          title: "Monthly theme readout",
          description:
            "Group the month's feedback into themes and post the top three with counts to the workspace.",
        },
      ],
    },
  },
  {
    slug: "design-request-queue",
    name: "Design request queue",
    description:
      "Intake for design work with a brief gate, so requests arrive with a goal and a deadline instead of a Slack link.",
    entityType: "list",
    category: "Design",
    useCases: ["Creative ops", "Intake", "Cross-functional"],
    complexity: "beginner",
    list: {
      color: "#f2c291",
      statuses: PIPELINE(["Requested", "In design", "In review", "Delivered"]),
      fields: [
        {
          name: "Deliverable",
          type: "dropdown",
          options: [
            { label: "Product UI", color: "#a9c6f2" },
            { label: "Brand", color: "#c6bcf2" },
            { label: "Web", color: "#a9dcbd" },
            { label: "Social", color: "#f2d491" },
          ],
        },
        { name: "Needed by", type: "date" },
        { name: "Brief attached", type: "checkbox" },
      ],
      tasks: [
        {
          title: "Publish the request template",
          description:
            "Goal, audience, format, deadline, and where it will be used. Requests without these go back.",
          priority: "high",
        },
        {
          title: "Agree the review ritual",
          description:
            "Two rounds of feedback, consolidated in one place, with a named decision maker.",
        },
      ],
    },
  },
  {
    slug: "brand-asset-production",
    name: "Brand asset production",
    description:
      "Track every asset from concept to exported file, with format, owner, and where it lives once it is done.",
    entityType: "list",
    category: "Design",
    useCases: ["Creative ops", "Launch", "Production"],
    complexity: "intermediate",
    list: {
      color: "#c6bcf2",
      statuses: [
        { name: "Concept", color: "#c9ccd4", category: "open" },
        { name: "Production", color: "#a9c6f2", category: "in_progress" },
        { name: "Review", color: "#f2d491", category: "in_progress" },
        { name: "Exported", color: "#a9dcbd", category: "complete" },
      ],
      fields: [
        {
          name: "Format",
          type: "dropdown",
          options: [
            { label: "Static", color: "#a9c6f2" },
            { label: "Motion", color: "#c6bcf2" },
            { label: "Print", color: "#f2d491" },
          ],
        },
        { name: "Final location", type: "text" },
        { name: "Accessibility checked", type: "checkbox" },
      ],
      tasks: [
        {
          title: "Asset naming convention",
          description:
            "One convention for filenames and folders so an asset can be found six months later.",
        },
        { title: "Export presets for every format", statusIndex: 1 },
      ],
    },
  },
  {
    slug: "sales-pipeline",
    name: "Sales pipeline",
    description:
      "Deals from lead to closed with value, close date, and the next step that actually moves the deal.",
    entityType: "list",
    category: "Sales",
    useCases: ["Pipeline", "Forecasting", "Revenue"],
    complexity: "intermediate",
    list: {
      color: "#a9dcbd",
      statuses: [
        { name: "Lead", color: "#c9ccd4", category: "open" },
        { name: "Qualified", color: "#a9c6f2", category: "in_progress" },
        { name: "Demo", color: "#c6bcf2", category: "in_progress" },
        { name: "Proposal", color: "#f2d491", category: "in_progress" },
        { name: "Closed won", color: "#a9dcbd", category: "complete" },
        { name: "Closed lost", color: "#c2c2ca", category: "closed" },
      ],
      fields: [
        { name: "Deal value", type: "number" },
        { name: "Expected close", type: "date" },
        { name: "Next step", type: "text" },
        {
          name: "Source",
          type: "dropdown",
          options: [
            { label: "Inbound", color: "#a9dcbd" },
            { label: "Outbound", color: "#a9c6f2" },
            { label: "Referral", color: "#f2d491" },
            { label: "Partner", color: "#c6bcf2" },
          ],
        },
      ],
      tasks: [
        {
          title: "Write the qualification criteria",
          description:
            "What has to be true before a lead becomes qualified: problem, budget, timeline, and decision maker.",
          priority: "high",
        },
        {
          title: "Build the discovery call script",
          statusIndex: 1,
          checklist: [
            "Opening and agenda",
            "Five problem questions",
            "Current workaround and its cost",
            "Agreed next step before hanging up",
          ],
        },
        {
          title: "Weekly pipeline review",
          description:
            "Every deal with no next step or a stale close date gets fixed or moved to closed lost.",
        },
      ],
    },
  },
  {
    slug: "customer-onboarding",
    name: "Customer onboarding",
    description:
      "A repeatable first thirty days per account: kickoff, configuration, training, and the value milestone.",
    entityType: "list",
    category: "Sales",
    useCases: ["Onboarding", "Retention", "Customer success"],
    complexity: "intermediate",
    list: {
      color: "#a9c6f2",
      statuses: [
        { name: "Kickoff", color: "#c9ccd4", category: "open" },
        { name: "Configuring", color: "#a9c6f2", category: "in_progress" },
        { name: "Training", color: "#c6bcf2", category: "in_progress" },
        { name: "Adopted", color: "#a9dcbd", category: "complete" },
        { name: "Stalled", color: "#f2c291", category: "in_progress" },
      ],
      fields: [
        { name: "Account", type: "text" },
        { name: "Go-live date", type: "date" },
        { name: "Seats", type: "number" },
        { name: "Executive sponsor named", type: "checkbox" },
      ],
      tasks: [
        {
          title: "Kickoff call",
          description:
            "Confirm the outcome the customer bought, the success metric, and who owns it on their side.",
          priority: "high",
          checklist: [
            "Success metric agreed in writing",
            "Sponsor and day-to-day owner named",
            "Go-live date set",
            "Risks noted",
          ],
          dueInDays: 3,
        },
        {
          title: "Import their data",
          statusIndex: 1,
          dueInDays: 10,
        },
        {
          title: "Train the core team",
          statusIndex: 2,
          dueInDays: 17,
        },
        {
          title: "Thirty-day value review",
          description:
            "Show the metric against the baseline. If it has not moved, say so and fix the plan.",
          dueInDays: 30,
        },
      ],
    },
  },
  {
    slug: "support-escalations",
    name: "Support escalations",
    description:
      "Escalated tickets with SLA clock, customer tier, and the engineering hand-off state.",
    entityType: "list",
    category: "Support",
    useCases: ["Escalation", "SLA", "Customer success"],
    complexity: "intermediate",
    list: {
      color: "#f2c291",
      statuses: [
        { name: "Escalated", color: "#f2c291", category: "open" },
        { name: "Investigating", color: "#a9c6f2", category: "in_progress" },
        { name: "With engineering", color: "#c6bcf2", category: "in_progress" },
        { name: "Awaiting customer", color: "#f2d491", category: "in_progress" },
        { name: "Resolved", color: "#a9dcbd", category: "complete" },
      ],
      fields: [
        {
          name: "Tier",
          type: "dropdown",
          options: [
            { label: "Enterprise", color: "#c6bcf2" },
            { label: "Business", color: "#a9c6f2" },
            { label: "Starter", color: "#c9ccd4" },
          ],
        },
        { name: "SLA due", type: "date" },
        { name: "Ticket ID", type: "text" },
        { name: "Workaround given", type: "checkbox" },
      ],
      tasks: [
        {
          title: "Define what earns an escalation",
          description:
            "Severity, tier, and time-open thresholds, so escalation is a rule rather than a favour.",
          priority: "high",
        },
        {
          title: "Write the hand-off template",
          description:
            "What engineering needs on arrival: repro steps, account, impact, and what support already tried.",
        },
      ],
    },
  },
  {
    slug: "hiring-pipeline",
    name: "Hiring pipeline",
    description:
      "Candidates from application to offer with stage, interviewer, and a scorecard checkbox that keeps hiring fair.",
    entityType: "list",
    category: "HR",
    useCases: ["Recruiting", "Interviewing", "People ops"],
    complexity: "intermediate",
    list: {
      color: "#c6bcf2",
      statuses: [
        { name: "Applied", color: "#c9ccd4", category: "open" },
        { name: "Screening", color: "#a9c6f2", category: "in_progress" },
        { name: "Interviewing", color: "#c6bcf2", category: "in_progress" },
        { name: "Debrief", color: "#f2d491", category: "in_progress" },
        { name: "Offer", color: "#a9dcbd", category: "complete" },
        { name: "Rejected", color: "#c2c2ca", category: "closed" },
      ],
      fields: [
        { name: "Role", type: "text" },
        { name: "Applied on", type: "date" },
        { name: "Scorecard submitted", type: "checkbox" },
        {
          name: "Source",
          type: "dropdown",
          options: [
            { label: "Referral", color: "#a9dcbd" },
            { label: "Inbound", color: "#a9c6f2" },
            { label: "Sourced", color: "#c6bcf2" },
          ],
        },
      ],
      tasks: [
        {
          title: "Write the role scorecard",
          description:
            "Four to six competencies with what strong looks like, agreed before the first interview.",
          priority: "high",
        },
        {
          title: "Set the interview loop",
          description:
            "Who runs which stage, how long, and what each stage is uniquely testing for.",
        },
        {
          title: "Candidate experience commitments",
          description:
            "Reply within five days, always give a decision, never leave a candidate waiting after a final round.",
        },
      ],
    },
  },
  {
    slug: "employee-onboarding",
    name: "Employee onboarding",
    description:
      "A new hire's first thirty days: accounts, context, first contribution, and the check-ins that catch problems early.",
    entityType: "list",
    category: "HR",
    useCases: ["Onboarding", "People ops", "Enablement"],
    complexity: "beginner",
    list: {
      color: "#a9dcbd",
      statuses: PIPELINE(["Before day one", "Week one", "In progress", "Done"]),
      fields: [
        { name: "Start date", type: "date" },
        { name: "Buddy", type: "text" },
        {
          name: "Phase",
          type: "dropdown",
          options: [
            { label: "Day 1", color: "#a9c6f2" },
            { label: "Week 1", color: "#c6bcf2" },
            { label: "Day 30", color: "#a9dcbd" },
          ],
        },
      ],
      tasks: [
        {
          title: "Accounts and access ready before day one",
          priority: "high",
          checklist: [
            "Email and chat",
            "Repository and deploy access",
            "Calendar invites for recurring meetings",
            "Hardware delivered",
          ],
        },
        { title: "Assign a buddy and book daily check-ins for week one" },
        {
          title: "Ship something small in week one",
          statusIndex: 1,
          description:
            "A real, merged change. The point is the path from idea to production, not the size of the change.",
        },
        {
          title: "Thirty-day conversation",
          dueInDays: 30,
          description:
            "What is clear, what is still confusing, and what would have made the first month easier.",
        },
      ],
    },
  },
  {
    slug: "month-end-close",
    name: "Month-end close",
    description:
      "The finance close as a dated checklist: reconciliations, accruals, review, and sign-off with an approval gate.",
    entityType: "list",
    category: "Finance",
    useCases: ["Accounting", "Compliance", "Recurring"],
    complexity: "advanced",
    list: {
      color: "#a9c6f2",
      statuses: [
        { name: "Not started", color: "#c9ccd4", category: "open" },
        { name: "In progress", color: "#a9c6f2", category: "in_progress" },
        { name: "In review", color: "#f2d491", category: "in_progress" },
        { name: "Signed off", color: "#a9dcbd", category: "complete" },
      ],
      fields: [
        { name: "Period", type: "text" },
        { name: "Due", type: "date" },
        {
          name: "Area",
          type: "dropdown",
          options: [
            { label: "Revenue", color: "#a9dcbd" },
            { label: "Payroll", color: "#c6bcf2" },
            { label: "AP", color: "#a9c6f2" },
            { label: "AR", color: "#f2d491" },
          ],
        },
        { name: "Evidence attached", type: "checkbox" },
      ],
      tasks: [
        {
          title: "Reconcile bank accounts",
          priority: "high",
          dueInDays: 3,
          checklist: [
            "All accounts imported",
            "Unmatched items investigated",
            "Reconciliation report attached",
          ],
        },
        { title: "Post accruals and prepayments", dueInDays: 4 },
        { title: "Revenue recognition review", dueInDays: 5 },
        {
          title: "Controller review and sign-off",
          dueInDays: 7,
          description:
            "Nothing closes until the reconciliations and the variance commentary have been reviewed.",
        },
      ],
    },
  },
  {
    slug: "client-project-delivery",
    name: "Client project delivery",
    description:
      "An agency engagement end to end: scope, milestones, client approvals, and the invoice that follows each one.",
    entityType: "list",
    category: "Agency",
    useCases: ["Client work", "Delivery", "Billing"],
    complexity: "advanced",
    list: {
      color: "#f2d491",
      statuses: [
        { name: "Scoping", color: "#c9ccd4", category: "open" },
        { name: "In production", color: "#a9c6f2", category: "in_progress" },
        { name: "Client review", color: "#f2d491", category: "in_progress" },
        { name: "Approved", color: "#c6bcf2", category: "in_progress" },
        { name: "Invoiced", color: "#a9dcbd", category: "complete" },
      ],
      fields: [
        { name: "Client", type: "text" },
        { name: "Milestone value", type: "number" },
        { name: "Due", type: "date" },
        { name: "Change request", type: "checkbox" },
      ],
      tasks: [
        {
          title: "Agree scope and the change-request rule",
          description:
            "What is in, what is out, and what happens to timeline and price when the client asks for more.",
          priority: "high",
        },
        {
          title: "Milestone one: discovery and plan",
          statusIndex: 1,
          checklist: [
            "Stakeholder interviews done",
            "Current state documented",
            "Plan presented",
            "Sign-off received in writing",
          ],
          dueInDays: 14,
        },
        {
          title: "Weekly client status note",
          description:
            "Shipped, in flight, blocked, and what we need from the client this week. Same shape every week.",
        },
      ],
    },
  },
  {
    slug: "vendor-procurement",
    name: "Vendor procurement",
    description:
      "Evaluate, review, and approve a new vendor with security review, pricing, and renewal date on the record.",
    entityType: "list",
    category: "Operations",
    useCases: ["Procurement", "Compliance", "Security"],
    complexity: "intermediate",
    list: {
      color: "#c9ccd4",
      statuses: [
        { name: "Requested", color: "#c9ccd4", category: "open" },
        { name: "Evaluating", color: "#a9c6f2", category: "in_progress" },
        { name: "Security review", color: "#c6bcf2", category: "in_progress" },
        { name: "Approved", color: "#a9dcbd", category: "complete" },
        { name: "Rejected", color: "#c2c2ca", category: "closed" },
      ],
      fields: [
        { name: "Annual cost", type: "number" },
        { name: "Renewal date", type: "date" },
        { name: "Handles customer data", type: "checkbox" },
        {
          name: "Owner team",
          type: "dropdown",
          options: [
            { label: "Engineering", color: "#a9c6f2" },
            { label: "Marketing", color: "#f2d491" },
            { label: "Finance", color: "#a9dcbd" },
            { label: "Operations", color: "#c9ccd4" },
          ],
        },
      ],
      tasks: [
        {
          title: "Publish the procurement checklist",
          description:
            "What every request must answer: problem, alternatives considered, data handled, and cost over three years.",
          priority: "high",
        },
        {
          title: "Set the renewal review cadence",
          description:
            "Sixty days before each renewal, confirm the tool is still used and still the best option.",
        },
      ],
    },
  },
  {
    slug: "course-production",
    name: "Course production",
    description:
      "Build a course module by module: outline, script, record, edit, publish, with a learning objective on every lesson.",
    entityType: "list",
    category: "Education",
    useCases: ["Curriculum", "Production", "Publishing"],
    complexity: "intermediate",
    list: {
      color: "#c6bcf2",
      statuses: [
        { name: "Outlined", color: "#c9ccd4", category: "open" },
        { name: "Scripted", color: "#c6bcf2", category: "in_progress" },
        { name: "Recorded", color: "#a9c6f2", category: "in_progress" },
        { name: "Edited", color: "#f2d491", category: "in_progress" },
        { name: "Published", color: "#a9dcbd", category: "complete" },
      ],
      fields: [
        { name: "Module", type: "number" },
        { name: "Learning objective", type: "text" },
        { name: "Runtime minutes", type: "number" },
        { name: "Exercise written", type: "checkbox" },
      ],
      tasks: [
        {
          title: "Write the course outcome",
          description:
            "One sentence: what a learner can do after finishing that they could not do before.",
          priority: "high",
        },
        {
          title: "Map modules to objectives",
          description:
            "Each module gets exactly one objective and one exercise that proves it.",
        },
        { title: "Record module one", statusIndex: 1 },
      ],
    },
  },
  {
    slug: "personal-week",
    name: "Personal week",
    description:
      "A calm weekly list: the three things that matter, errands, and a Friday review that resets the next week.",
    entityType: "list",
    category: "Personal",
    useCases: ["Planning", "Focus", "Habits"],
    complexity: "beginner",
    list: {
      color: "#a9dcbd",
      statuses: [
        { name: "This week", color: "#c9ccd4", category: "open" },
        { name: "Doing", color: "#a9c6f2", category: "in_progress" },
        { name: "Done", color: "#a9dcbd", category: "complete" },
        { name: "Dropped", color: "#c2c2ca", category: "closed" },
      ],
      fields: [
        {
          name: "Energy",
          type: "dropdown",
          options: [
            { label: "Deep work", color: "#c6bcf2" },
            { label: "Shallow", color: "#a9c6f2" },
            { label: "Errand", color: "#c9ccd4" },
          ],
        },
        { name: "Day", type: "date" },
      ],
      tasks: [
        {
          title: "Pick the three that matter this week",
          priority: "high",
          description:
            "If everything is important, nothing is. Three, written down, before Monday morning.",
        },
        { title: "Block two deep-work mornings" },
        {
          title: "Friday review",
          dueInDays: 5,
          checklist: [
            "What moved",
            "What stalled and why",
            "What to drop",
            "Next week's three",
          ],
        },
      ],
    },
  },

  // ── Tasks ─────────────────────────────────────────────────────────────
  {
    slug: "bug-report-task",
    name: "Bug report",
    description:
      "A defect written so somebody else can reproduce it: environment, steps, expected, actual, and impact.",
    entityType: "task",
    category: "Engineering",
    useCases: ["Quality", "Triage", "Support"],
    complexity: "beginner",
    task: {
      title: "Bug: [what breaks, in five words]",
      description:
        "Environment: browser, OS, account, and build.\n\nSteps to reproduce:\n1.\n2.\n3.\n\nExpected: what should have happened.\nActual: what happened instead.\n\nImpact: who is affected and how badly. Attach a recording if the failure is visual.",
      priority: "high",
      checklist: [
        "Reproduced on a clean session",
        "Environment and build recorded",
        "Screenshot or recording attached",
        "Severity set",
        "Owner assigned",
      ],
    },
  },
  {
    slug: "postmortem-action-task",
    name: "Postmortem action item",
    description:
      "A follow-up from an incident with the failure it prevents, a verification step, and an approval gate before it closes.",
    entityType: "task",
    category: "Engineering",
    useCases: ["Reliability", "Postmortem", "Follow-up"],
    complexity: "intermediate",
    task: {
      title: "Postmortem action: [the change that prevents recurrence]",
      description:
        "Incident: link the incident and its postmortem.\n\nFailure this prevents: describe the specific failure mode, not the category.\n\nHow we will know it worked: the alert, test, or metric that would have caught the incident earlier.",
      priority: "high",
      requiresApproval: true,
      dueInDays: 14,
      checklist: [
        "Root cause restated in one sentence",
        "Change implemented",
        "Detection added (alert, test, or dashboard)",
        "Verified against the original failure mode",
        "Runbook updated",
      ],
    },
  },
  {
    slug: "spec-review-task",
    name: "Feature spec review",
    description:
      "Circulate a spec for structured review: scope, risks, open questions, and a named decision maker.",
    entityType: "task",
    category: "Product",
    useCases: ["Specification", "Review", "Cross-functional"],
    complexity: "intermediate",
    task: {
      title: "Spec review: [feature name]",
      description:
        "Link the spec doc.\n\nReviewers: product, engineering, design, and anyone who owns a system this touches.\n\nWhat feedback is useful: scope, risk, and sequencing. What is already decided: state it here so review does not reopen it.",
      priority: "normal",
      dueInDays: 5,
      checklist: [
        "Spec linked and readable end to end",
        "Reviewers assigned with a deadline",
        "Open questions listed with owners",
        "Decisions recorded in the doc",
        "Estimate agreed with engineering",
      ],
      subtasks: [
        "Engineering review",
        "Design review",
        "Consolidate feedback and decide",
      ],
    },
  },
  {
    slug: "blog-post-task",
    name: "Blog post production",
    description:
      "One post from angle to published, with the editing and distribution steps people usually forget.",
    entityType: "task",
    category: "Marketing",
    useCases: ["Content", "Publishing", "SEO"],
    complexity: "beginner",
    task: {
      title: "Post: [working title]",
      description:
        "Angle: the specific claim this post makes.\nAudience: who should read it and what they already believe.\nCall to action: what they should do next.",
      priority: "normal",
      dueInDays: 10,
      checklist: [
        "Outline approved",
        "Draft written",
        "Edited for clarity and length",
        "Images and alt text added",
        "Metadata, canonical, and internal links set",
        "Scheduled and queued for distribution",
      ],
      subtasks: ["Draft", "Edit", "Publish and distribute"],
    },
  },
  {
    slug: "design-review-task",
    name: "Design review",
    description:
      "A design put in front of the right people with the question stated, so feedback lands on the decision that matters.",
    entityType: "task",
    category: "Design",
    useCases: ["Review", "Critique", "Cross-functional"],
    complexity: "beginner",
    task: {
      title: "Design review: [surface or flow]",
      description:
        "The problem this design solves, the constraints it works within, and the one question the review should answer.\n\nInclude the states people forget: empty, loading, error, and the smallest screen we support.",
      priority: "normal",
      dueInDays: 4,
      checklist: [
        "Goal and constraints written above the designs",
        "Empty, loading, and error states included",
        "Mobile width checked",
        "Accessibility contrast checked",
        "Decision recorded and owner noted",
      ],
    },
  },
  {
    slug: "discovery-call-task",
    name: "Sales discovery call",
    description:
      "Prepare, run, and follow up a discovery call so it ends with an agreed next step rather than a vague good chat.",
    entityType: "task",
    category: "Sales",
    useCases: ["Pipeline", "Qualification", "Meetings"],
    complexity: "beginner",
    task: {
      title: "Discovery call: [account]",
      description:
        "Before: research the account, name the likely problem, and write three questions you cannot answer from their website.\n\nDuring: spend most of the time on their current workaround and what it costs them.\n\nAfter: send the recap the same day.",
      priority: "high",
      dueInDays: 3,
      checklist: [
        "Account researched and hypothesis written",
        "Problem, timeline, and decision maker established",
        "Cost of the current workaround quantified",
        "Next step agreed before the call ends",
        "Recap email sent the same day",
      ],
    },
  },
  {
    slug: "new-hire-week-one-task",
    name: "New hire, week one",
    description:
      "The manager's side of a new start: access, context, a first contribution, and a check-in each day.",
    entityType: "task",
    category: "HR",
    useCases: ["Onboarding", "People ops", "Management"],
    complexity: "beginner",
    task: {
      title: "Week one: [new hire name]",
      description:
        "Goal for the week: they have access to everything, know who does what, and have merged one small change.\n\nBook fifteen minutes at the end of each day for the first week.",
      priority: "high",
      dueInDays: 7,
      checklist: [
        "Accounts and hardware ready before day one",
        "Buddy assigned",
        "Team intro meetings booked",
        "First small task picked and scoped",
        "Daily check-ins in the calendar",
        "Thirty-day conversation scheduled",
      ],
    },
  },
  {
    slug: "vendor-security-review-task",
    name: "Vendor security review",
    description:
      "Assess a vendor before it touches production or customer data, ending in an explicit approval decision.",
    entityType: "task",
    category: "Operations",
    useCases: ["Security", "Procurement", "Compliance"],
    complexity: "advanced",
    task: {
      title: "Security review: [vendor]",
      description:
        "What data the vendor will hold, where it is processed, and who at our end owns the relationship.\n\nAttach the vendor's current compliance reports and their subprocessor list.",
      priority: "high",
      requiresApproval: true,
      dueInDays: 14,
      checklist: [
        "Data classification recorded",
        "Compliance reports reviewed and current",
        "Subprocessors listed and acceptable",
        "Access scoped to least privilege",
        "Data deletion and exit path documented",
        "Renewal review scheduled",
      ],
    },
  },
  {
    slug: "weekly-review-task",
    name: "Weekly review",
    description:
      "A thirty-minute personal reset: close the loops, decide what to drop, and choose next week's three.",
    entityType: "task",
    category: "Personal",
    useCases: ["Planning", "Focus", "Habits"],
    complexity: "beginner",
    task: {
      title: "Weekly review",
      description:
        "Thirty minutes, same time each week. The goal is a clear head on Monday, not a longer list.",
      priority: "normal",
      dueInDays: 7,
      checklist: [
        "Inbox and notifications cleared",
        "Finished work archived",
        "Stalled items given a next step or dropped",
        "Calendar for next week reviewed",
        "Next week's three chosen",
      ],
    },
  },

  // ── Docs ──────────────────────────────────────────────────────────────
  {
    slug: "prd-doc",
    name: "Product requirements",
    description:
      "A PRD that stays short: the problem, who has it, what success looks like, and what is explicitly out of scope.",
    entityType: "doc",
    category: "Product",
    useCases: ["Specification", "Planning", "Cross-functional"],
    complexity: "intermediate",
    doc: {
      title: "PRD: [feature name]",
      body: [
        { h: "Summary", level: 2 },
        {
          p: "One paragraph a new joiner could read and understand what we are building and why now.",
        },
        { h: "Problem", level: 2 },
        {
          p: "Describe the problem in the customer's words. Include the workaround they use today and what it costs them.",
        },
        { h: "Who it is for", level: 2 },
        {
          ul: [
            "Primary user and the job they are trying to finish",
            "Secondary users affected by the change",
            "Who is explicitly not the audience",
          ],
        },
        { h: "Success criteria", level: 2 },
        {
          p: "The measurable change we expect, the baseline today, and when we will check.",
        },
        { h: "Scope", level: 2 },
        { h: "In scope", level: 3 },
        { ul: ["", "", ""] },
        { h: "Out of scope", level: 3 },
        {
          p: "List what we are deliberately not doing, so nobody relitigates it mid-build.",
        },
        { h: "Experience", level: 2 },
        {
          p: "Walk the main path end to end. Then cover the empty, loading, error, and permission-denied states.",
        },
        { h: "Risks and open questions", level: 2 },
        {
          ul: [
            "Risk, its likely impact, and how we would find out early",
            "Open question, the owner, and the date it must be answered by",
          ],
        },
        { h: "Rollout", level: 2 },
        {
          ol: [
            "Who gets it first and how we watch it",
            "What would make us roll it back",
            "What we tell customers, and when",
          ],
        },
        { hr: true },
        { p: "Decision log: date, decision, and who made it." },
      ],
    },
  },
  {
    slug: "engineering-rfc-doc",
    name: "Engineering RFC",
    description:
      "A design proposal built for disagreement: context, the proposal, the alternatives, and the trade-offs accepted.",
    entityType: "doc",
    category: "Engineering",
    useCases: ["Architecture", "Review", "Decision record"],
    complexity: "advanced",
    doc: {
      title: "RFC: [proposal]",
      body: [
        { h: "Status", level: 2 },
        { p: "Draft. Author, reviewers, and the date a decision is needed." },
        { h: "Context", level: 2 },
        {
          p: "What exists today, what forced this question now, and the constraints that are not negotiable.",
        },
        { h: "Proposal", level: 2 },
        {
          p: "The change, described concretely enough that a reviewer could implement it. Include data model, interfaces, and failure behaviour.",
        },
        { h: "Alternatives considered", level: 2 },
        {
          ul: [
            "Alternative, why it is appealing, and why we did not choose it",
            "Doing nothing: what happens if we leave this alone",
          ],
        },
        { h: "Trade-offs accepted", level: 2 },
        {
          p: "State the costs plainly: performance, complexity, migration effort, operational burden.",
        },
        { h: "Migration and rollback", level: 2 },
        {
          ol: [
            "How existing data moves",
            "How the change is deployed safely",
            "How we roll back if it goes wrong",
          ],
        },
        { h: "Security and privacy", level: 2 },
        {
          p: "New data collected, new trust boundaries crossed, and who can now see what.",
        },
        { h: "Open questions", level: 2 },
        { ul: ["", ""] },
        { hr: true },
        {
          quote:
            "A good RFC makes the disagreement explicit early, so the code review is about code.",
        },
      ],
    },
  },
  {
    slug: "postmortem-doc",
    name: "Incident postmortem",
    description:
      "Blameless postmortem: timeline, impact, contributing factors, and action items with owners and dates.",
    entityType: "doc",
    category: "Engineering",
    useCases: ["Reliability", "Postmortem", "Compliance"],
    complexity: "advanced",
    doc: {
      title: "Postmortem: [incident]",
      body: [
        { h: "Summary", level: 2 },
        {
          p: "Severity, duration, what customers experienced, and the single sentence explanation.",
        },
        { h: "Impact", level: 2 },
        {
          ul: [
            "Customers affected and how",
            "Requests, revenue, or data affected",
            "Duration from first impact to full recovery",
          ],
        },
        { h: "Timeline", level: 2 },
        {
          p: "All times UTC. Include detection, escalation, mitigation, and the moment recovery was confirmed.",
        },
        { ul: ["00:00 — ", "00:00 — ", "00:00 — "] },
        { h: "Contributing factors", level: 2 },
        {
          p: "Plural, and never a person. Describe the conditions that made this failure possible and likely.",
        },
        { h: "What went well", level: 2 },
        { ul: ["", ""] },
        { h: "What was difficult", level: 2 },
        { ul: ["", ""] },
        { h: "Action items", level: 2 },
        {
          p: "Each one becomes a task with an owner and a date. Prevention first, then detection, then response.",
        },
        { ol: ["Prevent — ", "Detect — ", "Respond — "] },
        { hr: true },
        {
          quote:
            "The purpose is to change the system, not to find the person who typed the command.",
        },
      ],
    },
  },
  {
    slug: "campaign-brief-doc",
    name: "Campaign brief",
    description:
      "A one-page brief that keeps a campaign honest: audience, insight, message, channels, and how success is measured.",
    entityType: "doc",
    category: "Marketing",
    useCases: ["Campaign", "Launch", "Creative"],
    complexity: "beginner",
    doc: {
      title: "Campaign brief: [campaign name]",
      body: [
        { h: "Objective", level: 2 },
        {
          p: "The business outcome, with a number and a date. Not awareness in general.",
        },
        { h: "Audience", level: 2 },
        {
          p: "Who specifically, what they believe today, and what we want them to believe after.",
        },
        { h: "Insight", level: 2 },
        {
          p: "The uncomfortable truth about their situation that makes the message land.",
        },
        { h: "Message", level: 2 },
        {
          ul: [
            "The one sentence we want repeated",
            "Three proofs that make it credible",
            "What we will not claim",
          ],
        },
        { h: "Channels and assets", level: 2 },
        { ul: ["Channel — asset — owner — date", "", ""] },
        { h: "Budget", level: 2 },
        { p: "Total, split by channel, and what is reserved for what works." },
        { h: "Measurement", level: 2 },
        {
          ol: [
            "Primary metric and its baseline",
            "Secondary metrics we will watch",
            "The date we review and decide to extend or stop",
          ],
        },
      ],
    },
  },
  {
    slug: "meeting-notes-doc",
    name: "Meeting notes",
    description:
      "Notes that survive the meeting: decisions, owners, and next steps separated from the discussion.",
    entityType: "doc",
    category: "Operations",
    useCases: ["Meetings", "Decision record", "Follow-up"],
    complexity: "beginner",
    doc: {
      title: "Meeting notes: [topic, date]",
      body: [
        { h: "Purpose", level: 2 },
        { p: "Why this meeting existed and what it had to produce." },
        { h: "Attendees", level: 2 },
        { p: "Names, and who was absent but needs the outcome." },
        { h: "Decisions", level: 2 },
        {
          p: "Each decision on its own line, in the past tense, with who made it.",
        },
        { ul: ["", ""] },
        { h: "Action items", level: 2 },
        { ul: ["Owner — action — due date", ""] },
        { h: "Discussion", level: 2 },
        {
          p: "The reasoning worth remembering. Skip the parts that changed nothing.",
        },
        { h: "Parked", level: 2 },
        { p: "Questions we deliberately did not answer, and when we will." },
      ],
    },
  },
  {
    slug: "okr-plan-doc",
    name: "Quarterly OKR plan",
    description:
      "Objectives with measurable key results, the bets behind them, and an honest confidence score per result.",
    entityType: "doc",
    category: "Operations",
    useCases: ["Planning", "Goals", "Reporting"],
    complexity: "intermediate",
    doc: {
      title: "OKRs: [quarter]",
      body: [
        { h: "Context", level: 2 },
        {
          p: "What happened last quarter, what we learned, and the one thing that must be true by the end of this one.",
        },
        { h: "Objective 1", level: 2 },
        { p: "A qualitative statement worth caring about." },
        {
          ul: [
            "Key result — from X to Y by [date] — owner — confidence",
            "Key result — from X to Y by [date] — owner — confidence",
          ],
        },
        { h: "Objective 2", level: 2 },
        { p: "" },
        { ul: ["Key result — from X to Y by [date] — owner — confidence"] },
        { h: "Bets", level: 2 },
        {
          p: "The specific projects we believe will move these results, and roughly what they will cost.",
        },
        { h: "What we are not doing", level: 2 },
        {
          p: "The credible ideas we are declining this quarter, so the list stays real.",
        },
        { h: "Check-in cadence", level: 2 },
        {
          ol: [
            "Weekly: owners update confidence",
            "Monthly: readout to the team",
            "End of quarter: score, learn, and reset",
          ],
        },
      ],
    },
  },
  {
    slug: "statement-of-work-doc",
    name: "Statement of work",
    description:
      "Client-ready scope: deliverables, milestones, assumptions, and exactly what triggers a change request.",
    entityType: "doc",
    category: "Agency",
    useCases: ["Client work", "Contracts", "Scoping"],
    complexity: "advanced",
    doc: {
      title: "Statement of work: [client, project]",
      body: [
        { h: "Parties and dates", level: 2 },
        { p: "Client, supplier, start date, and expected completion." },
        { h: "Objectives", level: 2 },
        { p: "What the client is buying, in outcomes rather than activities." },
        { h: "Deliverables", level: 2 },
        {
          ul: [
            "Deliverable — format — acceptance criteria",
            "Deliverable — format — acceptance criteria",
          ],
        },
        { h: "Milestones and payment", level: 2 },
        { ul: ["Milestone — date — amount", "Milestone — date — amount"] },
        { h: "Assumptions", level: 2 },
        {
          p: "What we assume the client provides: access, content, reviewers, and response times.",
        },
        { h: "Change requests", level: 2 },
        {
          p: "Anything outside the deliverables above is a change request, quoted separately before work begins.",
        },
        { h: "Acceptance", level: 2 },
        {
          p: "How a deliverable is accepted, how long review takes, and what happens if review stalls.",
        },
        { hr: true },
        { p: "Signatures and date." },
      ],
    },
  },
  {
    slug: "runbook-doc",
    name: "Operational runbook",
    description:
      "A procedure someone can follow at three in the morning: preconditions, steps, verification, and rollback.",
    entityType: "doc",
    category: "Operations",
    useCases: ["On-call", "Reliability", "Documentation"],
    complexity: "intermediate",
    doc: {
      title: "Runbook: [procedure]",
      body: [
        { h: "When to use this", level: 2 },
        {
          p: "The symptom or trigger. If the symptom does not match, stop and escalate instead.",
        },
        { h: "Before you start", level: 2 },
        {
          ul: [
            "Access required",
            "Who to notify",
            "What must be true before proceeding",
          ],
        },
        { h: "Steps", level: 2 },
        {
          ol: [
            "Exact command or click path, with the expected output",
            "Exact command or click path, with the expected output",
            "Exact command or click path, with the expected output",
          ],
        },
        { h: "Verify", level: 2 },
        {
          p: "The check that proves it worked. Name the dashboard, query, or log line.",
        },
        { h: "Rollback", level: 2 },
        { p: "How to undo each step, in reverse order." },
        { h: "If it does not work", level: 2 },
        { p: "Who to escalate to, and what to have ready when you do." },
        { hr: true },
        { p: "Last reviewed: [date] by [name]." },
      ],
    },
  },
  {
    slug: "lesson-plan-doc",
    name: "Lesson plan",
    description:
      "A single session designed backwards from the objective, with timings, activities, and a check for understanding.",
    entityType: "doc",
    category: "Education",
    useCases: ["Curriculum", "Teaching", "Workshops"],
    complexity: "beginner",
    doc: {
      title: "Lesson: [topic]",
      body: [
        { h: "Objective", level: 2 },
        {
          p: "By the end of this session, learners will be able to [do a specific thing].",
        },
        { h: "Prior knowledge", level: 2 },
        { p: "What learners must already know for this to land." },
        { h: "Plan", level: 2 },
        {
          ol: [
            "Hook (5 min) — the question or demonstration that creates the need",
            "Teach (15 min) — the smallest explanation that works",
            "Practice (20 min) — learners do it, you circulate",
            "Check (10 min) — evidence they can do it unaided",
            "Close (5 min) — restate the objective and preview what is next",
          ],
        },
        { h: "Materials", level: 2 },
        { ul: ["", ""] },
        { h: "Check for understanding", level: 2 },
        {
          p: "The specific task that shows whether the objective was met, and what you will do if it was not.",
        },
        { h: "Differentiation", level: 2 },
        {
          ul: [
            "For learners who finish early",
            "For learners who are stuck",
          ],
        },
      ],
    },
  },

  // ── Whiteboards ───────────────────────────────────────────────────────
  {
    slug: "brainstorm-board",
    name: "Diverge and converge",
    description:
      "A structured brainstorm: generate widely, cluster honestly, then pick. Frames keep the two modes separate.",
    entityType: "whiteboard",
    category: "Design",
    useCases: ["Workshops", "Ideation", "Facilitation"],
    complexity: "beginner",
    whiteboard: {
      title: "Diverge and converge",
      frames: [
        {
          title: "Frame the question",
          prompt:
            "Write the question as 'How might we…'. Everything on this board answers this one question.",
          notes: ["How might we…", "Constraints we must respect"],
        },
        {
          title: "Diverge",
          prompt:
            "Quantity first. One idea per note, no discussion, no judging. Eight minutes on a timer.",
          notes: ["Idea", "Idea", "Wild idea — keep it"],
        },
        {
          title: "Cluster",
          prompt:
            "Group notes that are really the same idea. Name each cluster in plain language.",
          notes: ["Cluster name", "Cluster name"],
        },
        {
          title: "Decide",
          prompt:
            "Two votes each. The top cluster becomes a task with an owner before anyone leaves the room.",
          notes: ["Chosen direction", "Owner and next step"],
        },
      ],
    },
  },
  {
    slug: "retro-board",
    name: "Sprint retrospective",
    description:
      "Start, stop, continue, plus the one improvement the team commits to before the next sprint begins.",
    entityType: "whiteboard",
    category: "Engineering",
    useCases: ["Retrospective", "Sprints", "Team health"],
    complexity: "beginner",
    whiteboard: {
      title: "Retrospective",
      frames: [
        {
          title: "Start",
          prompt: "What should we begin doing that we are not doing today?",
          notes: ["", ""],
        },
        {
          title: "Stop",
          prompt: "What is costing us more than it returns?",
          notes: ["", ""],
        },
        {
          title: "Continue",
          prompt: "What worked and should be protected?",
          notes: ["", ""],
        },
        {
          title: "One commitment",
          prompt:
            "Exactly one improvement, with an owner and a date. More than one and none of them happen.",
          notes: ["Commitment", "Owner and date"],
        },
      ],
    },
  },
  {
    slug: "user-journey-map",
    name: "User journey map",
    description:
      "Map a journey stage by stage — actions, thoughts, pain, and the opportunity each pain point creates.",
    entityType: "whiteboard",
    category: "Product",
    useCases: ["Research", "Experience", "Discovery"],
    complexity: "intermediate",
    whiteboard: {
      title: "User journey map",
      frames: [
        {
          title: "Persona and scenario",
          prompt:
            "Who is travelling this journey, and what are they trying to finish? Be specific enough to disagree with.",
          notes: ["Persona", "Scenario and trigger"],
        },
        {
          title: "Awareness",
          prompt: "What happens before they know we exist? Actions, thoughts, and friction.",
          notes: ["Action", "Thought", "Friction"],
        },
        {
          title: "First use",
          prompt: "The first session. Where does effort spike and where do they hesitate?",
          notes: ["Action", "Thought", "Friction"],
        },
        {
          title: "Habit",
          prompt: "What makes them come back a third time? What would break the habit?",
          notes: ["Action", "Thought", "Friction"],
        },
        {
          title: "Opportunities",
          prompt:
            "For each pain point above, one opportunity. Rank them, then turn the top three into tasks.",
          notes: ["Opportunity", "Opportunity"],
        },
      ],
    },
  },
  {
    slug: "lean-canvas-board",
    name: "Lean canvas",
    description:
      "A business idea on one surface: problem, segments, solution, advantage, channels, costs, and revenue.",
    entityType: "whiteboard",
    category: "Operations",
    useCases: ["Strategy", "Planning", "New ventures"],
    complexity: "intermediate",
    whiteboard: {
      title: "Lean canvas",
      frames: [
        {
          title: "Problem and alternatives",
          prompt:
            "The top three problems, and what people do instead today. Existing alternatives are the real competition.",
          notes: ["Problem", "Existing alternative"],
        },
        {
          title: "Customer segments",
          prompt: "Who exactly has this problem, and who among them feels it most?",
          notes: ["Segment", "Early adopter"],
        },
        {
          title: "Solution and advantage",
          prompt:
            "The smallest thing that solves the top problem, and what makes it hard to copy.",
          notes: ["Solution", "Unfair advantage"],
        },
        {
          title: "Channels and metrics",
          prompt: "How they find us, and the one number that tells us it is working.",
          notes: ["Channel", "Key metric"],
        },
        {
          title: "Costs and revenue",
          prompt: "What it costs to run, and how money actually arrives.",
          notes: ["Cost structure", "Revenue streams"],
        },
      ],
    },
  },
  {
    slug: "empathy-map-board",
    name: "Empathy map",
    description:
      "What a customer says, thinks, does, and feels — turned into the pains and gains that drive messaging.",
    entityType: "whiteboard",
    category: "Marketing",
    useCases: ["Research", "Messaging", "Positioning"],
    complexity: "beginner",
    whiteboard: {
      title: "Empathy map",
      frames: [
        {
          title: "Says and does",
          prompt: "Observable behaviour only. Quote them where you can.",
          notes: ["Quote", "Observed behaviour"],
        },
        {
          title: "Thinks and feels",
          prompt: "What occupies them, what worries them, what they will not say out loud.",
          notes: ["Belief", "Worry"],
        },
        {
          title: "Pains",
          prompt: "Frustrations, obstacles, and risks they are afraid of.",
          notes: ["Pain", "Risk"],
        },
        {
          title: "Gains",
          prompt: "What success looks like to them, and what would exceed it.",
          notes: ["Gain", "Delight"],
        },
        {
          title: "So what",
          prompt:
            "The sentence we would say to this person. If it is not sharper than the last one, keep going.",
          notes: ["Message", "Proof"],
        },
      ],
    },
  },

  // ── Saved views ───────────────────────────────────────────────────────
  {
    slug: "view-my-open-work",
    name: "My open work",
    description:
      "The list filtered to open tasks assigned to you — the first view to open in the morning.",
    entityType: "view",
    category: "Personal",
    useCases: ["Focus", "Daily", "Planning"],
    complexity: "beginner",
    view: {
      name: "My open work",
      view: "list",
      flags: "active,mine",
      answers: "What is on my plate in this list right now?",
    },
  },
  {
    slug: "view-sprint-board",
    name: "Sprint board",
    description:
      "Kanban of everything still open, so standup happens against columns instead of a spreadsheet.",
    entityType: "view",
    category: "Engineering",
    useCases: ["Sprints", "Standup", "Delivery"],
    complexity: "beginner",
    view: {
      name: "Sprint board",
      view: "board",
      flags: "active",
      answers: "Where is every open task in the workflow?",
    },
  },
  {
    slug: "view-blocked",
    name: "Blocked and waiting",
    description:
      "Only tasks with an open blocker — the shortest list in the workspace and the most useful.",
    entityType: "view",
    category: "Operations",
    useCases: ["Unblocking", "Standup", "Delivery"],
    complexity: "beginner",
    view: {
      name: "Blocked and waiting",
      view: "list",
      flags: "blocked",
      answers: "What is stuck, and on what?",
    },
  },
  {
    slug: "view-approval-queue",
    name: "Approval queue",
    description:
      "Tasks sitting behind a human approval gate, in a table so a reviewer can clear them in one pass.",
    entityType: "view",
    category: "Operations",
    useCases: ["Governance", "Review", "Agents"],
    complexity: "intermediate",
    view: {
      name: "Approval queue",
      view: "table",
      flags: "approval",
      answers: "What is waiting on a human decision?",
    },
  },
  {
    slug: "view-urgent-triage",
    name: "Urgent triage",
    description:
      "Open, urgent, and unfiltered by owner — the view to open when something is on fire.",
    entityType: "view",
    category: "Support",
    useCases: ["Triage", "Escalation", "On-call"],
    complexity: "beginner",
    view: {
      name: "Urgent triage",
      view: "table",
      flags: "active",
      priority: "urgent",
      answers: "What is urgent and still open?",
    },
  },
  {
    slug: "view-unassigned-intake",
    name: "Unassigned intake",
    description:
      "Open work with nobody's name on it — run it weekly and the queue never quietly rots.",
    entityType: "view",
    category: "Product",
    useCases: ["Triage", "Intake", "Planning"],
    complexity: "beginner",
    view: {
      name: "Unassigned intake",
      view: "list",
      flags: "active,unassigned",
      answers: "What has arrived that nobody owns yet?",
    },
  },
  {
    slug: "view-delivery-timeline",
    name: "Delivery timeline",
    description:
      "Start and due dates on a horizontal timeline, for the conversation about whether the dates are real.",
    entityType: "view",
    category: "Agency",
    useCases: ["Planning", "Client work", "Reporting"],
    complexity: "intermediate",
    view: {
      name: "Delivery timeline",
      view: "gantt",
      answers: "How do the dates in this list line up?",
    },
  },
];

// ── Derived catalog surface ─────────────────────────────────────────────

export type TemplateSummary = {
  slug: string;
  name: string;
  description: string;
  entityType: TemplateEntityType;
  category: TemplateCategory;
  useCases: string[];
  complexity: TemplateComplexity;
  /** Small labelled counts the card renders as tiles. */
  stats: { label: string; value: number }[];
  /** Heading for the sample lines below the stats. */
  sampleLabel: string;
  /** A few concrete lines showing what you actually get. */
  samples: string[];
  /** One line describing what the applied artifact will be. */
  outcome: string;
};

const SAMPLE_LIMIT = 4;

function trimSamples(lines: string[]): string[] {
  return lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, SAMPLE_LIMIT);
}

export function summarizeTemplate(t: CatalogTemplate): TemplateSummary {
  const base = {
    slug: t.slug,
    name: t.name,
    description: t.description,
    entityType: t.entityType,
    category: t.category,
    useCases: t.useCases,
    complexity: t.complexity,
  };

  if (t.entityType === "list") {
    const statuses = t.list.statuses ?? [];
    const fields = t.list.fields ?? [];
    const tasks = t.list.tasks ?? [];
    return {
      ...base,
      stats: [
        // No custom statuses means the list seeds the four defaults.
        { label: "Statuses", value: statuses.length || 4 },
        { label: "Fields", value: fields.length },
        { label: "Tasks", value: tasks.length },
      ],
      sampleLabel: "Starter tasks",
      samples: trimSamples(tasks.map((task) => task.title)),
      outcome: "Creates a list with its statuses, fields, and starter tasks.",
    };
  }

  if (t.entityType === "task") {
    return {
      ...base,
      stats: [
        { label: "Checklist", value: t.task.checklist.length },
        { label: "Subtasks", value: t.task.subtasks?.length ?? 0 },
        { label: "Gate", value: t.task.requiresApproval ? 1 : 0 },
      ],
      sampleLabel: "Acceptance criteria",
      samples: trimSamples(t.task.checklist),
      outcome: "Creates one task with its checklist and any subtasks.",
    };
  }

  if (t.entityType === "doc") {
    const headings = t.doc.body.filter(
      (b): b is { h: string; level?: 1 | 2 | 3 } => "h" in b,
    );
    const bullets = t.doc.body.reduce(
      (n, b) => n + ("ul" in b ? b.ul.length : "ol" in b ? b.ol.length : 0),
      0,
    );
    return {
      ...base,
      stats: [
        { label: "Sections", value: headings.length },
        { label: "Prompts", value: bullets },
        { label: "Blocks", value: t.doc.body.length },
      ],
      sampleLabel: "Sections",
      samples: trimSamples(headings.map((h) => h.h)),
      outcome: "Creates a doc pre-filled with its sections and prompts.",
    };
  }

  if (t.entityType === "whiteboard") {
    const notes = t.whiteboard.frames.reduce(
      (n, f) => n + (f.notes?.length ?? 0),
      0,
    );
    return {
      ...base,
      stats: [
        { label: "Frames", value: t.whiteboard.frames.length },
        { label: "Notes", value: notes },
        { label: "Prompts", value: t.whiteboard.frames.length },
      ],
      sampleLabel: "Frames",
      samples: trimSamples(t.whiteboard.frames.map((f) => f.title)),
      outcome: "Creates a board with its frames, prompts, and sticky notes.",
    };
  }

  const flags = t.view.flags ? t.view.flags.split(",") : [];
  return {
    ...base,
    stats: [
      { label: "Filters", value: flags.length + (t.view.priority ? 1 : 0) },
      { label: "Views", value: 1 },
      { label: "Setup", value: 0 },
    ],
    sampleLabel: "Preset",
    samples: trimSamples([
      `${t.view.view} view`,
      ...flags,
      t.view.priority ? `${t.view.priority} priority` : "",
      t.view.answers,
    ]),
    outcome: "Saves a filtered view preset onto a list.",
  };
}

export function findTemplate(slug: string): CatalogTemplate | undefined {
  return TEMPLATE_CATALOG.find((t) => t.slug === slug);
}

/**
 * The whole catalog plus its facets, ready for the Template Center's
 * filter row. Facets are derived rather than hand-maintained so adding a
 * template can never leave a filter option behind.
 */
export function templateCenterCatalog(): {
  templates: TemplateSummary[];
  categories: TemplateCategory[];
  entityTypes: TemplateEntityType[];
  complexities: TemplateComplexity[];
  useCases: string[];
} {
  const templates = TEMPLATE_CATALOG.map(summarizeTemplate);
  const present = new Set(templates.map((t) => t.category));
  return {
    templates,
    categories: TEMPLATE_CATEGORIES.filter((c) => present.has(c)),
    entityTypes: TEMPLATE_ENTITY_TYPES.filter((e) =>
      templates.some((t) => t.entityType === e),
    ),
    complexities: TEMPLATE_COMPLEXITIES,
    useCases: [...new Set(templates.flatMap((t) => t.useCases))].sort(),
  };
}
