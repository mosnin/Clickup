"use client";

// "What's your status?"
//
// One question, one row of presets, one line of text, one expiry. The failure
// mode this avoids is the settings page: a status editor with sections is a
// status nobody sets, and a status nobody sets is a field that lies about the
// three people who did.
//
// The one departure from Buzz is the expiry, and it is the most important
// thing here. Buzz has no expiry at all — clearing is explicit — which is why
// a Tuesday "In a meeting 🗣️" is still up on Thursday and everybody learns to
// ignore all of them. A status that clears itself is a status that stays true,
// so the duration sits beside the text rather than behind a disclosure.
//
// Both the presets and the durations come from `src/lib/buzz/presence.ts`, and
// so does the normalization: Save is enabled by `normalizeStatusDraft`
// returning something, which means whitespace alone never gets published and
// the button and the mutation cannot disagree about what "empty" is.

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import type { ChatScope } from "@/lib/buzz/channel-types";
import {
  STATUS_DURATIONS,
  USER_STATUS_MAX_LENGTH,
  USER_STATUS_PRESETS,
  normalizeStatusDraft,
} from "@/lib/buzz/presence";
import { StatusEmoji } from "./presence-dot";
import { clearStatusRef, myStatusRef, scopeArgs, setStatusRef } from "./refs";

export function StatusEditor({
  scope,
  onDone,
  className,
}: {
  scope: ChatScope | null;
  /** Called after a successful save or clear — usually "close the popover". */
  onDone?: () => void;
  className?: string;
}) {
  const { toast } = useToast();
  const current = useQuery(myStatusRef, scope ? scopeArgs(scope) : "skip");
  const save = useMutation(setStatusRef);
  const clear = useMutation(clearStatusRef);

  const [text, setText] = useState("");
  const [emoji, setEmoji] = useState("");
  const [minutes, setMinutes] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [seeded, setSeeded] = useState(false);

  // Seed once, from whatever is stored. Re-seeding on every change of the
  // subscription would overwrite what somebody is typing the moment their own
  // save landed — the dialog would fight them at the exact moment it appears
  // to be working.
  useEffect(() => {
    if (seeded || current === undefined) return;
    setText(current?.text ?? "");
    setEmoji(current?.emoji ?? "");
    setSeeded(true);
  }, [current, seeded]);

  const draft = normalizeStatusDraft({ text, emoji, minutes }, Date.now());
  const hasStored = Boolean(current?.text || current?.emoji);

  async function commit() {
    if (!scope || !draft || busy) return;
    setBusy(true);
    try {
      await save({
        ...scopeArgs(scope),
        text: draft.text,
        emoji: draft.emoji,
        ...(draft.expiresAt !== null ? { expiresAt: draft.expiresAt } : {}),
      });
      toast("Status updated");
      onDone?.();
    } catch (error) {
      // The server's own words. A refusal this surface invented would be a
      // second explanation for something with one cause.
      toast(error instanceof Error ? error.message : "Your status could not be saved", {
        kind: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  async function commitClear() {
    if (!scope || busy) return;
    setBusy(true);
    try {
      await clear(scopeArgs(scope));
      setText("");
      setEmoji("");
      setMinutes(null);
      toast("Status cleared");
      onDone?.();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Your status could not be cleared", {
        kind: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn("flex w-full flex-col gap-3", className)}>
      <div className="soft-field flex items-center gap-2 p-1.5">
        {/* The emoji is a text field and not a picker, deliberately: every
            platform has an emoji keyboard a keystroke away, a shortcode is
            typed rather than browsed, and a picker here would be the largest
            thing in a dialog whose subject is a sentence. */}
        <label className="sr-only" htmlFor="chat-status-emoji">
          Status emoji
        </label>
        <input
          id="chat-status-emoji"
          value={emoji}
          onChange={(event) => setEmoji(event.target.value.slice(0, 32))}
          placeholder="🙂"
          aria-label="Status emoji"
          className="w-10 shrink-0 rounded-md bg-transparent px-1 py-1 text-center text-base outline-none"
        />
        <label className="sr-only" htmlFor="chat-status-text">
          Status
        </label>
        <input
          id="chat-status-text"
          value={text}
          autoFocus
          maxLength={USER_STATUS_MAX_LENGTH}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Enter saves unless Shift is held — the same contract the
            // composer uses, so the two boxes in Chat behave alike.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void commit();
            }
          }}
          placeholder="What's your status?"
          className="min-w-0 flex-1 bg-transparent px-1 py-1 text-sm outline-none"
        />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {USER_STATUS_PRESETS.map((preset) => (
          <button
            key={preset.text}
            type="button"
            onClick={() => {
              setText(preset.text);
              setEmoji(preset.emoji);
            }}
            className="tap-target flex items-center gap-1.5 rounded-full bg-[var(--chat-hover)] px-2.5 py-1 text-xs transition-colors hover:opacity-80"
          >
            <StatusEmoji emoji={preset.emoji} />
            {preset.text}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <label htmlFor="chat-status-clears" className="chat-quiet shrink-0 text-xs">
          Clear after
        </label>
        <select
          id="chat-status-clears"
          value={minutes === null ? "" : String(minutes)}
          onChange={(event) =>
            setMinutes(event.target.value === "" ? null : Number(event.target.value))
          }
          className="soft-field min-w-0 flex-1 px-2 py-1.5 text-xs"
        >
          {STATUS_DURATIONS.map((duration) => (
            <option key={duration.label} value={duration.minutes === null ? "" : String(duration.minutes)}>
              {duration.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-2">
        {/* Only when there is one to clear. A permanently visible destructive
            button on a surface where nothing is set is a button whose only
            possible effect is to worry you. */}
        {hasStored ? (
          <button
            type="button"
            onClick={() => void commitClear()}
            disabled={busy}
            className="tap-target rounded-full px-3 py-1.5 text-xs font-medium underline underline-offset-2 disabled:opacity-50"
          >
            Clear status
          </button>
        ) : null}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => onDone?.()}
          className="tap-target rounded-full px-3 py-1.5 text-xs font-medium"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void commit()}
          disabled={!draft || busy || !scope}
          className="tap-target rounded-full bg-foreground px-3.5 py-1.5 text-xs font-medium text-[var(--color-page)] disabled:opacity-40"
        >
          Save
        </button>
      </div>
    </div>
  );
}
