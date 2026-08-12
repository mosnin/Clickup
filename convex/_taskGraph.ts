// Asking graph-shaped questions of work that was already a graph.
//
// `tasks.blockedByTaskIds` has been a DAG for a long time, and cycle
// enforcement is what makes traversing it safe rather than infinite. What was
// missing is that nothing ever asked it anything: the one existing surface
// hands an agent the adjacency list and leaves the reasoning to whatever the
// runtime feels like doing, which is the same mistake context assembly made.
//
// This is NOT a graph database. Convex tables plus indexes already are the
// graph; porting to one would be a rewrite no customer sees. This is the pure
// arithmetic over an edge list, testable without a browser or a backend.
//
// Four questions counting cannot answer:
//
// **What should be done next?** Not "what is ready" — several things are
// always ready — but which ready task RELEASES the most downstream work. A
// dispatcher that picks fairly among ready tasks is fair and slow; one that
// picks the task twelve others are waiting on is the same fleet finishing
// sooner. This is the highest-value thing an agent can know and the codebase
// already had every input for it.
//
// **How close is this, really?** 17 of 23 is a number that lies. Two projects
// at 74% are not equally close if one has six independent tasks left and the
// other has six that must happen in order. The graph knows which.
//
// **What is unreachable?** Every watchdog in this product detects absence. A
// chain whose only ready head sits in a list the fleet is fenced out of is not
// absent — it is present, healthy, and will never move. Nothing could see that.
//
// **What is nearby?** An arriving agent asking for context gets "here is
// everything". The neighbourhood of a task is a bounded traversal and a far
// better answer.
//
// Defensive by construction, for the reason `pack.ts` is: this runs over data
// agents write. Cycles cannot happen (they are refused on write) and are
// handled anyway; every traversal is bounded; nothing recurses.

export type GraphNode = {
  id: string;
  /** Complete or closed — a done task blocks nothing. */
  done: boolean;
  /** Ids this task waits on. Unknown ids are ignored, not assumed open. */
  blockedBy: string[];
};

/**
 * A hard ceiling on any single traversal.
 *
 * Not a performance tuning knob — a guarantee. These functions run inside a
 * Convex query over data an agent authored, and a bound that exists only in
 * the shape of the input is not a bound.
 */
const MAX_VISITS = 10_000;

type Index = {
  byId: Map<string, GraphNode>;
  /** id → tasks that are waiting on it. The reverse of `blockedBy`. */
  dependents: Map<string, string[]>;
};

function index(nodes: GraphNode[]): Index {
  const byId = new Map<string, GraphNode>();
  for (const n of nodes) byId.set(n.id, n);
  const dependents = new Map<string, string[]>();
  for (const n of nodes) {
    for (const dep of n.blockedBy) {
      // An edge to a task we cannot see is dropped rather than invented. A
      // blocker outside the readable set is somebody else's business, and
      // treating it as open would make every cross-boundary task look stuck.
      if (!byId.has(dep)) continue;
      const list = dependents.get(dep);
      if (list) list.push(n.id);
      else dependents.set(dep, [n.id]);
    }
  }
  return { byId, dependents };
}

/** Open blockers only — a done blocker is history. */
function openBlockers(node: GraphNode, idx: Index): string[] {
  return node.blockedBy.filter((id) => {
    const b = idx.byId.get(id);
    return b !== undefined && !b.done;
  });
}

/** Open, and nothing open is in front of it. */
export function readyTasks(nodes: GraphNode[]): string[] {
  const idx = index(nodes);
  return nodes
    .filter((n) => !n.done && openBlockers(n, idx).length === 0)
    .map((n) => n.id);
}

/**
 * How much open work finishing this task would eventually release.
 *
 * Transitive and deduped: a task twelve others transitively wait on scores 12,
 * however the edges are arranged. Done descendants are not counted — they are
 * not waiting on anything.
 *
 * Note what this deliberately does NOT do: it does not stop at descendants
 * that have OTHER open blockers. A task blocked by both this one and something
 * else is still waiting on this one, and finishing this one is still progress
 * toward it. Counting only what becomes immediately ready would score a task
 * at the head of a long chain the same as a leaf, which is exactly backwards.
 */
export function blastRadius(nodes: GraphNode[], id: string): number {
  const idx = index(nodes);
  return descendants(idx, id).size;
}

function descendants(idx: Index, id: string): Set<string> {
  const seen = new Set<string>();
  const queue = [id];
  let visits = 0;
  while (queue.length > 0 && visits < MAX_VISITS) {
    const current = queue.pop()!;
    for (const next of idx.dependents.get(current) ?? []) {
      visits++;
      if (seen.has(next)) continue;
      const node = idx.byId.get(next);
      if (node === undefined) continue;
      // A done task is not waiting, but work behind it may still be, so the
      // walk continues through it without counting it.
      if (!node.done) seen.add(next);
      queue.push(next);
    }
  }
  seen.delete(id);
  return seen;
}

/**
 * The ready tasks, best first.
 *
 * This is the ranking that turns a dispatcher from fair into effective. Ties
 * break on remaining depth — between two tasks that release the same amount of
 * work, the one at the head of the longer chain should go first, because the
 * chain behind it is what will still be running at the end of the day.
 * Then by id, so the answer is stable rather than incidentally ordered.
 */
export function unlockRanking(
  nodes: GraphNode[],
): { id: string; unlocks: number; depth: number }[] {
  const idx = index(nodes);
  const ready = nodes.filter(
    (n) => !n.done && openBlockers(n, idx).length === 0,
  );
  return ready
    .map((n) => ({
      id: n.id,
      unlocks: descendants(idx, n.id).size,
      depth: remainingDepth(idx, n.id),
    }))
    .sort(
      (a, b) =>
        b.unlocks - a.unlocks ||
        b.depth - a.depth ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

/**
 * The longest chain of open work starting here, counting this task.
 *
 * Memoized over the whole call, and iterative rather than recursive: the input
 * is agent-authored and a recursive walk of a long chain is a stack overflow
 * inside a query.
 */
function remainingDepth(idx: Index, id: string, memo = new Map<string, number>()): number {
  const stack: string[] = [id];
  const inProgress = new Set<string>();
  let visits = 0;
  while (stack.length > 0 && visits++ < MAX_VISITS) {
    const current = stack[stack.length - 1];
    if (memo.has(current)) {
      stack.pop();
      continue;
    }
    const node = idx.byId.get(current);
    if (node === undefined || node.done) {
      memo.set(current, 0);
      stack.pop();
      continue;
    }
    const children = (idx.dependents.get(current) ?? []).filter((c) => {
      const n = idx.byId.get(c);
      return n !== undefined && !n.done;
    });
    const pending = children.filter((c) => !memo.has(c) && !inProgress.has(c));
    if (pending.length > 0) {
      inProgress.add(current);
      for (const c of pending) stack.push(c);
      continue;
    }
    // A cycle cannot occur (they are refused on write) but if one did, the
    // in-progress children are treated as depth 0 rather than looping forever.
    const best = children.reduce((m, c) => Math.max(m, memo.get(c) ?? 0), 0);
    memo.set(current, 1 + best);
    inProgress.delete(current);
    stack.pop();
  }
  return memo.get(id) ?? 0;
}

/**
 * Progress that accounts for shape.
 *
 * `done`/`total` is the number everybody already has. `criticalRemaining` is
 * the one that answers "how close": the longest chain of open work left, which
 * is the minimum number of sequential steps between here and finished however
 * many agents are thrown at it. Six independent tasks is a depth of 1; six in
 * a row is a depth of 6, and no count can tell those apart.
 */
export function flowProgress(nodes: GraphNode[]): {
  total: number;
  done: number;
  open: number;
  ready: number;
  criticalRemaining: number;
} {
  const idx = index(nodes);
  const memo = new Map<string, number>();
  let criticalRemaining = 0;
  for (const n of nodes) {
    if (n.done) continue;
    criticalRemaining = Math.max(
      criticalRemaining,
      remainingDepth(idx, n.id, memo),
    );
  }
  const done = nodes.filter((n) => n.done).length;
  return {
    total: nodes.length,
    done,
    open: nodes.length - done,
    ready: readyTasks(nodes).length,
    criticalRemaining,
  };
}

/**
 * Open work that nobody able to act on it can reach.
 *
 * `canReach` answers "could the fleet touch this task at all" — list fences,
 * capabilities, whatever the caller means by it. A task is structurally
 * stalled when it is open, and every path to it passes through a ready head
 * nobody can pick up. That is invisible to every other check in the product,
 * all of which look for things that stopped rather than things that were never
 * going to start.
 *
 * Returns the unreachable HEADS rather than everything behind them: the
 * blocked tail is a consequence, and reporting a hundred rows for one
 * misconfigured fence would bury the fix.
 */
export function structuralStalls(
  nodes: GraphNode[],
  canReach: (id: string) => boolean,
): { id: string; blocking: number }[] {
  const idx = index(nodes);
  const stalls: { id: string; blocking: number }[] = [];
  for (const n of nodes) {
    if (n.done) continue;
    if (openBlockers(n, idx).length > 0) continue;
    // Ready, and nobody can pick it up.
    if (canReach(n.id)) continue;
    stalls.push({ id: n.id, blocking: descendants(idx, n.id).size });
  }
  return stalls.sort(
    (a, b) => b.blocking - a.blocking || (a.id < b.id ? -1 : 1),
  );
}

/**
 * The bounded neighbourhood of one task, both directions.
 *
 * What an arriving agent should be given instead of the whole board: what this
 * is waiting on, and what is waiting on it, to a fixed depth. Both directions
 * matter and for different reasons — upstream is why you cannot start,
 * downstream is who you are holding up.
 */
export function neighbourhood(
  nodes: GraphNode[],
  id: string,
  depth = 2,
): { upstream: string[]; downstream: string[] } {
  const idx = index(nodes);
  const walk = (next: (n: string) => string[]) => {
    const seen = new Set<string>();
    let frontier = [id];
    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const following: string[] = [];
      for (const current of frontier) {
        for (const n of next(current)) {
          if (n === id || seen.has(n)) continue;
          if (seen.size >= MAX_VISITS) break;
          seen.add(n);
          following.push(n);
        }
      }
      frontier = following;
    }
    return [...seen];
  };
  return {
    upstream: walk((n) => idx.byId.get(n)?.blockedBy ?? []).filter((x) =>
      idx.byId.has(x),
    ),
    downstream: walk((n) => idx.dependents.get(n) ?? []),
  };
}
