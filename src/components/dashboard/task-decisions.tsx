"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  CheckCircle2,
  GitBranch,
  Plus,
  RefreshCw,
  ShieldAlert,
  X,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";

type DecisionRow = NonNullable<
  ReturnType<typeof useQuery<typeof api.decisions.listForTask>>
>[number];

export function TaskDecisions({
  taskId,
  listId,
}: {
  taskId: Id<"tasks">;
  listId: Id<"lists">;
}) {
  const rows = useQuery(api.decisions.listForTask, { taskId });
  const packets = useQuery(api.contextPackets.listForTask, { taskId });
  const create = useMutation(api.decisions.create);
  const supersede = useMutation(api.decisions.supersede);
  const assess = useMutation(api.decisions.assessImpact);
  const { toast } = useToast();

  const [editing, setEditing] = useState<"new" | DecisionRow | null>(null);
  const [key, setKey] = useState("");
  const [title, setTitle] = useState("");
  const [statement, setStatement] = useState("");
  const [rationale, setRationale] = useState("");
  const [contextPacketId, setContextPacketId] = useState("");
  const [assessmentId, setAssessmentId] =
    useState<Id<"decisionImpacts"> | null>(null);
  const [assessmentNote, setAssessmentNote] = useState("");
  const [pending, setPending] = useState(false);

  function openNew() {
    setEditing("new");
    setKey("");
    setTitle("");
    setStatement("");
    setRationale("");
    setContextPacketId("");
  }

  function openSupersede(row: DecisionRow) {
    setEditing(row);
    setKey(row.key);
    setTitle(row.title);
    setStatement(row.statement);
    setRationale("");
    setContextPacketId(row.contextPacketId ?? "");
  }

  function closeEditor() {
    setEditing(null);
    setKey("");
    setTitle("");
    setStatement("");
    setRationale("");
    setContextPacketId("");
  }

  async function save() {
    if (!title.trim() || !statement.trim() || !rationale.trim()) return;
    setPending(true);
    try {
      if (editing === "new") {
        if (!key.trim()) return;
        await create({
          listId,
          key: key.trim(),
          title: title.trim(),
          statement: statement.trim(),
          rationale: rationale.trim(),
          contextPacketId: contextPacketId
            ? (contextPacketId as Id<"contextPackets">)
            : undefined,
          taskIds: [taskId],
        });
        toast("Decision recorded — task impact review is now required");
      } else if (editing) {
        await supersede({
          decisionId: editing.decisionId,
          title: title.trim(),
          statement: statement.trim(),
          rationale: rationale.trim(),
        });
        toast("Decision superseded — affected tasks need revalidation");
      }
      closeEditor();
    } catch (error) {
      toast(errorMessage(error, "Couldn't save decision"), { kind: "error" });
    } finally {
      setPending(false);
    }
  }

  async function assessImpact(
    row: DecisionRow,
    status: "no_change" | "rework_required" | "resolved",
  ) {
    const note = assessmentId === row.impactId ? assessmentNote.trim() : "";
    if (status === "rework_required" && !note) {
      setAssessmentId(row.impactId);
      return;
    }
    setPending(true);
    try {
      await assess({
        impactId: row.impactId,
        status,
        note: note || undefined,
      });
      setAssessmentId(null);
      setAssessmentNote("");
      toast(
        status === "no_change"
          ? "Impact reviewed — no task change needed"
          : status === "resolved"
            ? "Required rework marked resolved"
            : "Task blocked until the required rework is resolved",
      );
    } catch (error) {
      toast(errorMessage(error, "Couldn't assess decision impact"), {
        kind: "error",
      });
    } finally {
      setPending(false);
    }
  }

  const blocking =
    rows?.filter(
      (row) =>
        row.impactStatus === "pending" ||
        row.impactStatus === "rework_required",
    ).length ?? 0;

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Operating decisions
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Immutable choices, rationale, and task-by-task revalidation.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {blocking > 0 && (
            <Badge variant="destructive">{blocking} need review</Badge>
          )}
          <Button size="sm" variant="outline" onClick={openNew}>
            <Plus className="h-3.5 w-3.5" />
            Record decision
          </Button>
        </div>
      </div>

      {editing && (
        <Card className="mb-3 block space-y-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold">
                {editing === "new"
                  ? "Record an operating decision"
                  : `Supersede ${editing.key} v${editing.version}`}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                The prior version stays in history.
              </p>
            </div>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Close decision editor"
              onClick={closeEditor}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          {editing === "new" && (
            <input
              value={key}
              onChange={(event) => setKey(event.currentTarget.value)}
              placeholder="Stable key, e.g. launch.region"
              maxLength={80}
              className="soft-field w-full px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          )}
          <input
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
            placeholder="Human-readable title"
            maxLength={160}
            className="soft-field w-full px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <textarea
            value={statement}
            onChange={(event) => setStatement(event.currentTarget.value)}
            rows={3}
            placeholder="What is now true?"
            className="soft-field w-full resize-y px-3 py-2 text-sm leading-6 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <textarea
            value={rationale}
            onChange={(event) => setRationale(event.currentTarget.value)}
            rows={3}
            placeholder="Why was this chosen or changed?"
            className="soft-field w-full resize-y px-3 py-2 text-sm leading-6 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          {editing === "new" && (packets?.length ?? 0) > 0 && (
            <select
              value={contextPacketId}
              onChange={(event) =>
                setContextPacketId(event.currentTarget.value)
              }
              aria-label="Linked context packet"
              className="soft-field w-full px-3 py-2 text-sm"
            >
              <option value="">No linked context packet</option>
              {packets?.map((packet) => (
                <option key={packet.packetId} value={packet.packetId}>
                  Update and invalidate {packet.title} · v{packet.version}
                </option>
              ))}
            </select>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={closeEditor}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={
                pending ||
                (editing === "new" && !key.trim()) ||
                !title.trim() ||
                !statement.trim() ||
                !rationale.trim()
              }
              onClick={() => void save()}
            >
              {pending
                ? "Saving…"
                : editing === "new"
                  ? "Record decision"
                  : "Create next version"}
            </Button>
          </div>
        </Card>
      )}

      {rows === undefined ? (
        <div className="h-20 animate-pulse rounded-xl bg-muted/50" />
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center">
          <GitBranch className="mx-auto h-5 w-5 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">No operating decisions yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Record the choices agents must not silently reinterpret.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => {
            const active = row.decisionStatus === "active";
            const blocked =
              row.impactStatus === "pending" ||
              row.impactStatus === "rework_required";
            return (
              <Card key={row.impactId} className="block space-y-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-tiny text-muted-foreground">
                        {row.key}
                      </span>
                      <Badge variant="secondary">v{row.version}</Badge>
                      <Badge variant={active ? "outline" : "secondary"}>
                        {row.decisionStatus}
                      </Badge>
                      <ImpactBadge status={row.impactStatus} />
                    </div>
                    <h3 className="mt-2 text-sm font-semibold">{row.title}</h3>
                  </div>
                  {active && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => openSupersede(row)}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Supersede
                    </Button>
                  )}
                </div>
                <div className="grid gap-3 text-sm sm:grid-cols-2">
                  <div className="rounded-lg bg-muted/35 p-3">
                    <p className="text-micro font-semibold uppercase tracking-wider text-muted-foreground">
                      Decision
                    </p>
                    <p className="mt-1.5 whitespace-pre-wrap leading-6">
                      {row.statement}
                    </p>
                  </div>
                  <div className="rounded-lg bg-muted/35 p-3">
                    <p className="text-micro font-semibold uppercase tracking-wider text-muted-foreground">
                      Rationale
                    </p>
                    <p className="mt-1.5 whitespace-pre-wrap leading-6 text-foreground/80">
                      {row.rationale}
                    </p>
                  </div>
                </div>
                {row.assessmentNote && (
                  <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs leading-5">
                    <span className="font-semibold">Impact note:</span>{" "}
                    {row.assessmentNote}
                  </p>
                )}
                {assessmentId === row.impactId && (
                  <textarea
                    autoFocus
                    value={assessmentNote}
                    onChange={(event) =>
                      setAssessmentNote(event.currentTarget.value)
                    }
                    rows={2}
                    placeholder="What must change before this task can continue?"
                    className="soft-field w-full resize-y px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                )}
                <div className="flex flex-wrap justify-end gap-2">
                  {row.impactStatus === "pending" && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => void assessImpact(row, "no_change")}
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        No task change
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() =>
                          assessmentId === row.impactId && assessmentNote.trim()
                            ? void assessImpact(row, "rework_required")
                            : setAssessmentId(row.impactId)
                        }
                      >
                        <ShieldAlert className="h-3.5 w-3.5" />
                        {assessmentId === row.impactId
                          ? "Require this rework"
                          : "Needs rework"}
                      </Button>
                    </>
                  )}
                  {row.impactStatus === "rework_required" && (
                    <Button
                      size="sm"
                      disabled={pending}
                      onClick={() => void assessImpact(row, "resolved")}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Mark rework resolved
                    </Button>
                  )}
                  {!blocked && row.impactStatus === "no_change" && (
                    <span className="self-center text-xs text-muted-foreground">
                      Reviewed; execution may continue.
                    </span>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ImpactBadge({ status }: { status: DecisionRow["impactStatus"] }) {
  if (status === "pending") return <Badge variant="destructive">Review needed</Badge>;
  if (status === "rework_required") {
    return <Badge variant="destructive">Rework required</Badge>;
  }
  if (status === "resolved") {
    return (
      <Badge className="border-emerald-500/40 text-emerald-600 dark:text-emerald-400" variant="outline">
        Rework resolved
      </Badge>
    );
  }
  return (
    <Badge className="border-emerald-500/40 text-emerald-600 dark:text-emerald-400" variant="outline">
      No change
    </Badge>
  );
}

