"use client";

// "Report this message."
//
// The dialog is deliberately small: one question, one row of categories, one
// optional note. A report is a signal, never a trigger — nothing is removed by
// filing one — so the form should not feel like an accusation being weighed.
//
// Two rules from §6.1 that are enforced here rather than left to habit:
//
//   • **The form resets every time it opens.** A prior selection surviving into
//     the next report is a category chosen by accident, and a mis-categorised
//     report is one a moderator triages in the wrong order.
//   • **The copy says who sees it.** "Reports go to this community's moderators
//     for review. The author is not notified of who reported them." People
//     under-report when they cannot tell whether the person they are reporting
//     will find out.

import { useEffect, useState } from "react";
import { Dialog } from "radix-ui";
import { X } from "lucide-react";
import { useMutation } from "convex/react";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import type { ChatScope } from "@/lib/buzz/channel-types";
import {
  REPORT_TYPES,
  REPORT_TYPE_LABELS,
  type ReportType,
} from "@/lib/buzz/moderation";
import { reasonOf, submitReport } from "./moderation-data";

export function ReportMessageDialog({
  scope,
  open,
  onOpenChange,
  target,
  targetKind = "event",
}: {
  scope: ChatScope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** An event id, or a pubkey when reporting a person rather than a message. */
  target: string;
  targetKind?: "event" | "pubkey";
}) {
  const [reportType, setReportType] = useState<ReportType | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const report = useMutation(submitReport);

  // Reset on open, not on close: a dialog cleared on close still shows the old
  // selection for the frame before it unmounts, and Radix keeps the tree
  // mounted through the exit animation.
  useEffect(() => {
    if (open) {
      setReportType(null);
      setNote("");
      setBusy(false);
    }
  }, [open]);

  async function submit() {
    if (!reportType || busy) return;
    setBusy(true);
    try {
      const result = await report({
        ...scope,
        targetKind,
        target,
        reportType,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      toast(
        result.created
          ? "Report submitted to community moderators"
          : "You have already reported this — moderators have it",
      );
      onOpenChange(false);
    } catch (error) {
      toast(reasonOf(error), { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-foreground/20" />
        <Dialog.Content className="bento fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-background p-5 shadow-lg">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-base font-semibold">
                Report this {targetKind === "event" ? "message" : "person"}
              </Dialog.Title>
              <Dialog.Description className="chat-quiet mt-1 text-xs">
                Reports go to this community&apos;s moderators for review. The author
                is not notified of who reported them.
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Close"
              className="chat-icon-button tap-target shrink-0"
            >
              <X aria-hidden className="size-4" />
            </Dialog.Close>
          </div>

          <fieldset className="mt-4">
            <legend className="chat-quiet text-tiny uppercase tracking-wider">
              What is wrong with it
            </legend>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {REPORT_TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  aria-pressed={reportType === type}
                  onClick={() => setReportType(type)}
                  className={cn(
                    "tap-target rounded-full px-3 py-1 text-xs transition-colors",
                    reportType === type
                      ? "bg-foreground font-semibold text-background"
                      : "bg-muted/70 hover:bg-muted",
                  )}
                >
                  {REPORT_TYPE_LABELS[type]}
                </button>
              ))}
            </div>
          </fieldset>

          <label className="mt-4 block">
            <span className="chat-quiet text-tiny uppercase tracking-wider">
              Anything moderators should know (optional)
            </span>
            <textarea
              value={note}
              rows={3}
              onChange={(event) => setNote(event.target.value)}
              className="soft-field mt-1 w-full resize-none px-3 py-2 text-sm outline-none"
            />
          </label>

          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close className="tap-target rounded-full px-3 py-1.5 text-xs hover:bg-muted">
              Cancel
            </Dialog.Close>
            <button
              type="button"
              disabled={!reportType || busy}
              onClick={() => void submit()}
              className="tap-target rounded-full bg-foreground px-3 py-1.5 text-xs font-semibold text-background disabled:opacity-40"
            >
              Submit report
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
