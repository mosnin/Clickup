export type Slot =

  | "expr"

  | "free"

  | "end";

export interface Fragment {
  text: string;

  in: Slot;

  out: Slot;

  comment?: boolean;
}

// The bag the ribbon draws from.
//
// Structurally untouched from the original — two languages so however the bag
// shuffles a row looks like it came from one project, every string cut
// mid-expression so any two can butt together and still read as source that got
// sliced, and `in`/`out` slots so the joins are legal rather than lucky.
//
// The DOMAIN is ours. It arrived as GLSL and numpy — fbm, curl noise, pixel
// buffers — which is a coherent domain and the wrong one: this sits under copy
// about runs, claims, spend and approvals landing in an append-only log, and a
// wall of shader maths under that sentence quietly says the screenshot came
// from somewhere else. The two languages are now the two an agent actually
// touches here: the TypeScript MCP client, and the Python it runs.
export const FRAGMENTS: Fragment[] = [
  // The client side.
  { text: "task = await claim(", in: "free", out: "expr" },
  { text: "run = await startRun(", in: "free", out: "expr" },
  { text: "(task.id, agent)", in: "expr", out: "free" },
  { text: ", \"in_review\")", in: "expr", out: "free" },
  { text: "(task.dueAt - now)", in: "free", out: "free" },
  { text: " && !blockedBy", in: "free", out: "expr" },
  { text: "budget -= run.costUsd", in: "free", out: "expr" },
  { text: " * 1.02;", in: "expr", out: "end" },
  { text: "task = await nextTask(", in: "free", out: "expr" },
  { text: " scope.workspaceId);", in: "expr", out: "end" },
  { text: "const open = tasks.filter(", in: "free", out: "expr" },
  { text: " t => !t.done);", in: "expr", out: "end" },
  { text: "claim = lock(task, 60", in: "free", out: "expr" },
  { text: "left = sprint.remaining(", in: "free", out: "expr" },
  { text: " + carried * 0.15);", in: "expr", out: "end" },
  { text: "status = pick(a, b,", in: "free", out: "expr" },
  { text: " needsApproval ? 1 : 0", in: "expr", out: "expr" },
  { text: "emitRunEvent({ step,", in: "free", out: "expr" },
  { text: " \"finished\" });", in: "expr", out: "end" },
  { text: "requireApproval(task)", in: "free", out: "free" },
  { text: "canAccess(actor, list)", in: "free", out: "expr" },
  { text: " ? \"member\" : \"readonly\";", in: "expr", out: "end" },
  { text: "handoff = to(agent)", in: "free", out: "expr" },
  { text: " .withNotes;", in: "expr", out: "end" },
  { text: "const apiVersion = 1;", in: "free", out: "end" },

  // The runtime side.
  { text: "task, agent = ctx", in: "free", out: "expr" },
  { text: ".claim", in: "expr", out: "free" },
  { text: "cost: float", in: "free", out: "free" },
  { text: "spend = (used * 100.0)", in: "free", out: "expr" },
  { text: " % daily", in: "expr", out: "free" },
  { text: "def on_task(task):", in: "free", out: "end" },
  { text: "def report(run):", in: "free", out: "end" },
  { text: "[task][run]", in: "expr", out: "free" },
  { text: " = plan.copy()", in: "expr", out: "free" },
  { text: "for t in sprint:", in: "free", out: "end" },
  { text: "log = run.events()", in: "free", out: "free" },
  { text: "queue = deque(", in: "free", out: "expr" },
  { text: ", maxlen=limit)", in: "expr", out: "free" },
  { text: "board[col][row] = str(", in: "free", out: "expr" },
  { text: "t.status)", in: "expr", out: "free" },
  { text: "return run.finish(", in: "free", out: "expr" },
  { text: '"complete")', in: "expr", out: "free" },
  { text: "with operate.session(", in: "free", out: "expr" },
  { text: "key) as op:", in: "expr", out: "end" },
  { text: "min(spend, daily_limit)", in: "free", out: "free" },
  { text: "nonce = uuid4()", in: "free", out: "free" },

  { text: "# needs a human", in: "free", out: "end", comment: true },
  { text: "# claim expires in 60m", in: "free", out: "end", comment: true },
  { text: "# 0..1 of the sprint", in: "free", out: "end", comment: true },
  { text: "// blocked by #248", in: "free", out: "end", comment: true },
  { text: "// hand it back", in: "free", out: "end", comment: true },
];


export function makeBag<T>(items: T[]): () => T {
  let pool: T[] = [];
  return () => {
    if (!pool.length) {
      pool = items.slice();

      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
    }
    return pool.pop() as T;
  };
}

export function drawMatching(
  next: () => Fragment,
  need: Slot,
  tries = 6,
): Fragment {
  let f = next();
  for (let i = 0; i < tries && (f.in !== need || f.comment); i++) f = next();
  return f;
}
