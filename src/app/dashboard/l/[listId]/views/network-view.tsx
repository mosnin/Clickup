"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/dashboard/empty-state";
import { taskPeekHref } from "@/components/dashboard/task-peek";
import { Monogram } from "@/components/dashboard/monogram";
import {
  PriorityDot,
  type TaskPriority,
} from "@/components/dashboard/priority";
import { Reveal } from "@/components/motion";

// Dependency network diagram — a layered DAG built from
// tasks.blockedByTaskIds (blocker → blocked). Layout is computed once per
// data change in a useMemo: longest-path layering (Kahn's algorithm) puts
// unblocked tasks in the leftmost column and lets each edge cross exactly
// one column boundary, then a barycenter pass orders nodes within a
// column to keep edges as straight (and as uncrossed) as possible.

type NetworkResult = FunctionReturnType<typeof api.network.forList>;
type NetworkTask = NonNullable<NetworkResult>[number];

const NODE_W = 200;
const NODE_H = 156;
const COL_GAP = 72;
const ROW_GAP = 20;
const COL_W = NODE_W + COL_GAP;
const ROW_H = NODE_H + ROW_GAP;

type LayoutNode = {
  task: NetworkTask;
  layer: number;
  row: number;
  x: number;
  y: number;
  inCycle: boolean;
};

type LayoutEdge = {
  from: Id<"tasks">;
  to: Id<"tasks">;
  critical: boolean;
};

type Layout = {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  isolated: NetworkTask[];
  width: number;
  height: number;
};

function isDone(task: NetworkTask): boolean {
  return (
    task.statusCategory === "complete" || task.statusCategory === "closed"
  );
}

function computeLayout(tasks: NetworkTask[]): Layout {
  const byId = new Map(tasks.map((t) => [t._id, t]));
  const predecessors = new Map<Id<"tasks">, Id<"tasks">[]>();
  const successors = new Map<Id<"tasks">, Id<"tasks">[]>();

  for (const t of tasks) {
    predecessors.set(t._id, [...t.blockedByTaskIds]);
    if (!successors.has(t._id)) successors.set(t._id, []);
    for (const blockerId of t.blockedByTaskIds) {
      if (!byId.has(blockerId)) continue;
      const list = successors.get(blockerId) ?? [];
      list.push(t._id);
      successors.set(blockerId, list);
    }
  }

  // Isolated = zero in-list edges and zero cross-list blockers. These are
  // set aside into the collapsed strip rather than drawn as bare dots.
  const isolated: NetworkTask[] = [];
  const graphTasks: NetworkTask[] = [];
  for (const t of tasks) {
    const degree =
      (predecessors.get(t._id)?.length ?? 0) +
      (successors.get(t._id)?.length ?? 0) +
      t.crossListBlockers.length;
    if (degree === 0) isolated.push(t);
    else graphTasks.push(t);
  }

  if (graphTasks.length === 0) {
    return { nodes: [], edges: [], isolated, width: 0, height: 0 };
  }

  // ── Layering: Kahn's algorithm with deterministic cycle-breaking ──
  const indegree = new Map<Id<"tasks">, number>();
  for (const t of graphTasks) indegree.set(t._id, 0);
  for (const t of graphTasks) {
    for (const p of predecessors.get(t._id) ?? []) {
      if (!indegree.has(p)) continue;
      indegree.set(t._id, (indegree.get(t._id) ?? 0) + 1);
    }
  }

  const layer = new Map<Id<"tasks">, number>();
  const processed = new Set<Id<"tasks">>();
  const processedOrder: Id<"tasks">[] = [];
  const inCycle = new Set<Id<"tasks">>();
  const sortedGraphIds = graphTasks
    .map((t) => t._id)
    .sort((a, b) => a.localeCompare(b));

  const queue: Id<"tasks">[] = sortedGraphIds.filter(
    (id) => (indegree.get(id) ?? 0) === 0,
  );
  for (const id of queue) layer.set(id, 0);

  while (processed.size < graphTasks.length) {
    if (queue.length === 0) {
      // Everything left is part of a cycle (every remaining node still has
      // an unprocessed predecessor). Force the lowest-id remaining node in
      // so the algorithm always terminates, and badge it.
      const remaining = sortedGraphIds.filter((id) => !processed.has(id));
      if (remaining.length === 0) break;
      const forced = remaining[0];
      inCycle.add(forced);
      let maxProcessedLayer = -1;
      for (const id of processedOrder) {
        maxProcessedLayer = Math.max(maxProcessedLayer, layer.get(id) ?? 0);
      }
      layer.set(forced, maxProcessedLayer + 1);
      queue.push(forced);
    }
    const id = queue.shift();
    if (id === undefined || processed.has(id)) continue;
    processed.add(id);
    processedOrder.push(id);
    const curLayer = layer.get(id) ?? 0;
    for (const succ of successors.get(id) ?? []) {
      layer.set(succ, Math.max(layer.get(succ) ?? 0, curLayer + 1));
      const remaining = (indegree.get(succ) ?? 0) - 1;
      indegree.set(succ, Math.max(remaining, 0));
      if (remaining <= 0 && !processed.has(succ) && !queue.includes(succ)) {
        queue.push(succ);
      }
    }
  }

  // ── Ordering within each layer: barycenter of already-placed predecessors ──
  const maxLayer = Math.max(...[...layer.values()], 0);
  const byLayer = new Map<number, Id<"tasks">[]>();
  for (const id of sortedGraphIds) {
    const l = layer.get(id) ?? 0;
    const bucket = byLayer.get(l) ?? [];
    bucket.push(id);
    byLayer.set(l, bucket);
  }

  const rowIndex = new Map<Id<"tasks">, number>();
  for (let l = 0; l <= maxLayer; l++) {
    const ids = byLayer.get(l) ?? [];
    if (l === 0) {
      ids.sort(
        (a, b) => (byId.get(a)?.position ?? 0) - (byId.get(b)?.position ?? 0),
      );
    } else {
      ids.sort((a, b) => {
        const bary = (id: Id<"tasks">) => {
          const preds = (predecessors.get(id) ?? []).filter((p) =>
            rowIndex.has(p),
          );
          if (preds.length === 0) return Number.POSITIVE_INFINITY;
          const sum = preds.reduce((acc, p) => acc + (rowIndex.get(p) ?? 0), 0);
          return sum / preds.length;
        };
        const ba = bary(a);
        const bb = bary(b);
        if (ba !== bb) return ba - bb;
        return (byId.get(a)?.position ?? 0) - (byId.get(b)?.position ?? 0);
      });
    }
    ids.forEach((id, i) => rowIndex.set(id, i));
  }

  // ── Critical path: longest chain weighted by still-open tasks ──
  const dp = new Map<Id<"tasks">, number>();
  const parent = new Map<Id<"tasks">, Id<"tasks"> | null>();
  for (const id of processedOrder) {
    let best = 0;
    let bestParent: Id<"tasks"> | null = null;
    for (const p of predecessors.get(id) ?? []) {
      const pv = dp.get(p);
      if (pv !== undefined && pv > best) {
        best = pv;
        bestParent = p;
      }
    }
    const task = byId.get(id);
    const weight = task && !isDone(task) ? 1 : 0;
    dp.set(id, best + weight);
    parent.set(id, bestParent);
  }
  let endId: Id<"tasks"> | null = null;
  let bestTotal = -1;
  for (const id of processedOrder) {
    const v = dp.get(id) ?? 0;
    if (v > bestTotal) {
      bestTotal = v;
      endId = id;
    }
  }
  const criticalNodes = new Set<Id<"tasks">>();
  const criticalEdgeKeys = new Set<string>();
  let cur = endId;
  while (cur) {
    criticalNodes.add(cur);
    const p = parent.get(cur);
    if (p) criticalEdgeKeys.add(`${p}->${cur}`);
    cur = p ?? null;
  }

  const nodes: LayoutNode[] = graphTasks.map((task) => {
    const l = layer.get(task._id) ?? 0;
    const row = rowIndex.get(task._id) ?? 0;
    return {
      task,
      layer: l,
      row,
      x: l * COL_W,
      y: row * ROW_H,
      inCycle: inCycle.has(task._id),
    };
  });

  const edges: LayoutEdge[] = [];
  for (const t of graphTasks) {
    for (const p of predecessors.get(t._id) ?? []) {
      if (!byId.has(p)) continue;
      edges.push({
        from: p,
        to: t._id,
        critical: criticalEdgeKeys.has(`${p}->${t._id}`),
      });
    }
  }

  let maxRows = 0;
  for (const bucket of byLayer.values()) maxRows = Math.max(maxRows, bucket.length);

  return {
    nodes,
    edges,
    isolated,
    width: (maxLayer + 1) * COL_W - COL_GAP,
    height: Math.max(maxRows * ROW_H - ROW_GAP, NODE_H),
  };
}

export function NetworkView(props: {
  listId: Id<"lists">;
  tasks: Doc<"tasks">[];
  statuses: Doc<"listStatuses">[];
}) {
  const data = useQuery(api.network.forList, { listId: props.listId });
  const people = useQuery(api.agents.listAssignableForList, {
    listId: props.listId,
  });
  const searchParams = useSearchParams();
  const [showIsolated, setShowIsolated] = useState(false);

  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of people ?? []) map.set(p.id, p.name);
    return map;
  }, [people]);

  const layout = useMemo(
    () => (data ? computeLayout(data) : null),
    [data],
  );

  if (data === undefined) {
    return (
      <div className="panel rounded-2xl p-4">
        <div className="flex gap-4 overflow-hidden">
          {[0, 1, 2].map((col) => (
            <div key={col} className="flex flex-col gap-4">
              {[0, 1].map((row) => (
                <div
                  key={row}
                  className="h-32 w-[200px] flex-shrink-0 animate-pulse rounded-xl bg-muted/50"
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (data === null || !layout) {
    return (
      <EmptyState
        title="Can&apos;t load the network"
        message="You may no longer have access to this list."
      />
    );
  }

  const totalEdges =
    layout.edges.length +
    data.reduce((acc, t) => acc + t.crossListBlockers.length, 0);

  if (totalEdges === 0) {
    return (
      <EmptyState
        title="No dependencies yet"
        message="Set “Blocked by” on a task from its task page to connect it to another task here."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="panel overflow-auto rounded-2xl p-4">
        <div className="mb-3 flex items-center justify-end gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="inline-block h-0.5 w-4 rounded-full bg-foreground/70" />
            Critical path
          </span>
        </div>
        <div
          className="relative"
          style={{
            width: layout.width,
            height: layout.height,
            minWidth: NODE_W,
          }}
        >
          <svg
            className="pointer-events-none absolute left-0 top-0 overflow-visible"
            width={layout.width}
            height={layout.height}
          >
            <defs>
              <marker
                id="network-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L10,5 L0,10 z" fill="var(--color-border)" />
              </marker>
              <marker
                id="network-arrow-critical"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L10,5 L0,10 z" fill="var(--color-foreground)" />
              </marker>
            </defs>
            {layout.edges.map((edge) => {
              const from = layout.nodes.find((n) => n.task._id === edge.from);
              const to = layout.nodes.find((n) => n.task._id === edge.to);
              if (!from || !to) return null;
              const x1 = from.x + NODE_W;
              const y1 = from.y + NODE_H / 2;
              const x2 = to.x;
              const y2 = to.y + NODE_H / 2;
              const dx = Math.max((x2 - x1) / 2, 24);
              const path = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
              return (
                <path
                  key={`${edge.from}-${edge.to}`}
                  d={path}
                  fill="none"
                  stroke={
                    edge.critical
                      ? "var(--color-foreground)"
                      : "var(--color-border)"
                  }
                  strokeWidth={edge.critical ? 2.25 : 1.5}
                  markerEnd={
                    edge.critical
                      ? "url(#network-arrow-critical)"
                      : "url(#network-arrow)"
                  }
                />
              );
            })}
          </svg>

          {layout.nodes.map((node) => (
            <NodeCard
              key={node.task._id}
              node={node}
              nameById={nameById}
              searchParams={searchParams}
            />
          ))}
        </div>
      </div>

      {layout.isolated.length > 0 && (
        <div className="panel rounded-2xl">
          <button
            type="button"
            onClick={() => setShowIsolated((v) => !v)}
            className="tap-target flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium"
            aria-expanded={showIsolated}
          >
            <span>No dependencies ({layout.isolated.length})</span>
            <span className="text-xs font-normal text-muted-foreground">
              {showIsolated ? "Hide" : "Show"}
            </span>
          </button>
          {showIsolated && (
            <Reveal className="border-t border-border/60">
              <ul>
                {layout.isolated.map((task) => (
                  <li key={task._id}>
                    <Link
                      href={taskPeekHref(searchParams, task._id)}
                      scroll={false}
                      className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-muted/60"
                    >
                      <span
                        aria-hidden
                        className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full"
                        style={{ backgroundColor: task.statusColor }}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {task.title}
                      </span>
                      {task.priority && (
                        <PriorityDot priority={task.priority as TaskPriority} />
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </Reveal>
          )}
        </div>
      )}
    </div>
  );
}

function NodeCard({
  node,
  nameById,
  searchParams,
}: {
  node: LayoutNode;
  nameById: Map<string, string>;
  searchParams: URLSearchParams;
}) {
  const { task } = node;
  const done = isDone(task);
  const shownAssignees = task.assigneeClerkIds.slice(0, 3);
  const extraAssignees = task.assigneeClerkIds.length - shownAssignees.length;

  return (
    <Link
      href={taskPeekHref(searchParams, task._id)}
      scroll={false}
      className={cn(
        "bento-tile absolute flex flex-col gap-1.5 overflow-hidden rounded-xl p-3 transition-shadow hover:shadow-md",
        done && "opacity-60",
      )}
      style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}
    >
      <div className="flex items-start justify-between gap-1.5">
        <p className="line-clamp-2 flex-1 text-sm font-medium leading-snug">
          {task.title}
        </p>
        {task.milestone && (
          <span
            aria-label="Milestone"
            title="Milestone"
            className="mt-0.5 h-2 w-2 flex-shrink-0 rotate-45 border border-foreground/60"
          />
        )}
      </div>

      <Badge
        variant="secondary"
        className="w-fit gap-1.5 border-transparent text-[11px] text-foreground/80"
        style={{ backgroundColor: `${task.statusColor}4d` }}
      >
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: task.statusColor }}
        />
        {task.statusName}
      </Badge>

      <div className="mt-auto flex items-center justify-between gap-1.5">
        <div className="flex items-center gap-1.5">
          {task.priority && (
            <PriorityDot priority={task.priority as TaskPriority} />
          )}
          {task.estimatePoints !== undefined && (
            <Badge
              variant="secondary"
              className="gap-0 border-transparent bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
            >
              {task.estimatePoints} pt{task.estimatePoints === 1 ? "" : "s"}
            </Badge>
          )}
        </div>
        {shownAssignees.length > 0 && (
          <div className="flex -space-x-1.5">
            {shownAssignees.map((id) => (
              <Monogram
                key={id}
                name={nameById.get(id) ?? id}
                size="sm"
                className="ring-2 ring-background"
              />
            ))}
            {extraAssignees > 0 && (
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground ring-2 ring-background">
                +{extraAssignees}
              </span>
            )}
          </div>
        )}
      </div>

      {(node.inCycle || task.crossListBlockers.length > 0) && (
        <div className="flex flex-wrap items-center gap-1">
          {node.inCycle && (
            <Badge
              variant="secondary"
              className="gap-0 border-transparent text-[10px] text-foreground/80 dark:text-neutral-900/80"
              style={{ backgroundColor: "var(--color-pastel-red)" }}
              title="Part of a dependency cycle"
            >
              Cycle
            </Badge>
          )}
          {task.crossListBlockers.length > 0 && (
            <Badge
              variant="secondary"
              className="gap-0 border-transparent bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
              title={task.crossListBlockers
                .map((b) => `${b.title} (${b.listName})`)
                .join(", ")}
            >
              +{task.crossListBlockers.length} external
            </Badge>
          )}
        </div>
      )}
    </Link>
  );
}
