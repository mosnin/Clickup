"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { BookOpen, Link2, Pencil, Plus, X } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";

type Packet = {
  packetId: Id<"contextPackets">;
  title: string;
  summary?: string;
  content: string;
  version: number;
  updatedAt: number;
};

export function TaskContext({
  taskId,
  listId,
}: {
  taskId: Id<"tasks">;
  listId: Id<"lists">;
}) {
  const attached = useQuery(api.contextPackets.listForTask, { taskId });
  const available = useQuery(api.contextPackets.listForList, { listId });
  const create = useMutation(api.contextPackets.create);
  const update = useMutation(api.contextPackets.update);
  const attach = useMutation(api.contextPackets.attach);
  const detach = useMutation(api.contextPackets.detach);
  const { toast } = useToast();

  const [editing, setEditing] = useState<Packet | "new" | null>(null);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [content, setContent] = useState("");
  const [attachId, setAttachId] = useState("");
  const [pending, setPending] = useState(false);

  const attachedIds = useMemo(
    () => new Set((attached ?? []).map((packet) => packet.packetId)),
    [attached],
  );
  const unattached = (available ?? []).filter(
    (packet) => !attachedIds.has(packet.packetId),
  );

  function openNew() {
    setEditing("new");
    setTitle("");
    setSummary("");
    setContent(
      "## Objective\n\n## Constraints\n\n## Confirmed decisions\n\n## References\n\n## Open questions\n",
    );
  }

  function openEdit(packet: Packet) {
    setEditing(packet);
    setTitle(packet.title);
    setSummary(packet.summary ?? "");
    setContent(packet.content);
  }

  function closeEditor() {
    setEditing(null);
    setTitle("");
    setSummary("");
    setContent("");
  }

  async function save() {
    if (!title.trim() || !content.trim()) return;
    setPending(true);
    try {
      if (editing === "new") {
        await create({
          listId,
          title: title.trim(),
          summary: summary.trim() || undefined,
          content: content.trim(),
          taskIds: [taskId],
        });
        toast("Context packet created and attached");
      } else if (editing) {
        await update({
          packetId: editing.packetId,
          title: title.trim(),
          summary: summary.trim() || null,
          content: content.trim(),
        });
        toast("Context updated — agents will see the new version");
      }
      closeEditor();
    } catch (err) {
      toast(errorMessage(err, "Couldn't save context"), { kind: "error" });
    } finally {
      setPending(false);
    }
  }

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Shared context
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Versioned source of truth loaded by every agent working this task.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={openNew}>
          <Plus className="h-3.5 w-3.5" />
          New packet
        </Button>
      </div>

      {editing && (
        <Card className="mb-3 block space-y-3 p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">
              {editing === "new" ? "New context packet" : "Update context"}
            </p>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Close context editor"
              onClick={closeEditor}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <input
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
            placeholder="Source of truth title"
            maxLength={120}
            className="soft-field w-full px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <input
            value={summary}
            onChange={(event) => setSummary(event.currentTarget.value)}
            placeholder="One-line summary (optional)"
            maxLength={500}
            className="soft-field w-full px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <textarea
            value={content}
            onChange={(event) => setContent(event.currentTarget.value)}
            rows={10}
            placeholder="Objective, constraints, decisions, references, and open questions…"
            className="soft-field w-full resize-y px-3 py-2 font-mono text-xs leading-5 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={closeEditor}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={pending || !title.trim() || !content.trim()}
              onClick={() => void save()}
            >
              {pending ? "Saving…" : "Save context"}
            </Button>
          </div>
        </Card>
      )}

      {attached === undefined ? (
        <div className="h-20 animate-pulse rounded-xl bg-muted/50" />
      ) : attached.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center">
          <BookOpen className="mx-auto h-5 w-5 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">No shared context yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Add the brief once so parallel agents stop reconstructing it.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {(attached as Packet[]).map((packet) => (
            <details
              key={packet.packetId}
              className="group rounded-xl border border-border bg-card"
            >
              <summary className="flex cursor-pointer list-none items-start gap-3 px-4 py-3">
                <BookOpen className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand-600" />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{packet.title}</span>
                    <Badge variant="secondary">v{packet.version}</Badge>
                  </span>
                  {packet.summary && (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {packet.summary}
                    </span>
                  )}
                </span>
              </summary>
              <div className="border-t border-border px-4 py-3">
                <pre className="whitespace-pre-wrap font-sans text-sm leading-6 text-foreground/85">
                  {packet.content}
                </pre>
                <div className="mt-3 flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => openEdit(packet)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Edit source
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      try {
                        await detach({ packetId: packet.packetId, taskId });
                        toast("Context detached");
                      } catch (err) {
                        toast(errorMessage(err, "Couldn't detach context"), {
                          kind: "error",
                        });
                      }
                    }}
                  >
                    <X className="h-3.5 w-3.5" />
                    Detach
                  </Button>
                </div>
              </div>
            </details>
          ))}
        </div>
      )}

      {unattached.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select
            aria-label="Existing context packet"
            value={attachId}
            onChange={(event) => setAttachId(event.currentTarget.value)}
            className="soft-field min-w-0 flex-1 px-3 py-1.5 text-sm"
          >
            <option value="">Attach existing project context…</option>
            {unattached.map((packet) => (
              <option key={packet.packetId} value={packet.packetId}>
                {packet.title} · v{packet.version}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            disabled={!attachId}
            onClick={async () => {
              if (!attachId) return;
              try {
                await attach({
                  packetId: attachId as Id<"contextPackets">,
                  taskId,
                });
                setAttachId("");
                toast("Context attached");
              } catch (err) {
                toast(errorMessage(err, "Couldn't attach context"), {
                  kind: "error",
                });
              }
            }}
          >
            <Link2 className="h-3.5 w-3.5" />
            Attach
          </Button>
        </div>
      )}
    </section>
  );
}
