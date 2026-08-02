"use client";

// "Remind me later."
//
// One question at a time, and the question is *when* — five full-width presets
// on the centre axis, a custom date and time under them, an optional note. Not
// a settings panel with a recurrence rule and a timezone picker, because the
// thing a person is doing here takes two seconds and the dialog should too.
//
// The two guards that matter are both about the same failure. A `type="time"`
// input has no `min`, so picking today and a time that has already gone is the
// commonest slip there is — and it produces a reminder that fires immediately,
// which reads as a bug rather than as the schedule it literally is. So the date
// input carries `min={today}` and the Set button stays disabled until
// `parseCustomDateTime` says the instant is strictly in the future. The server
// refuses it too (`convex/buzz/reminders.ts`); this is the half that stops the
// person having to find out by being told no.

import { useCallback, useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import type { ChatScope } from "@/lib/buzz/channel-types";
import {
  TIME_PRESETS,
  parseCustomDateTime,
  todayDateString,
} from "./model";

export type RemindTarget = {
  eventId: string;
  channelId: string;
  preview: string;
  authorPubkey: string;
};

type CreateArgs = {
  scopeType: string;
  scopeId: string;
  notBefore: number;
  note?: string;
  target?: RemindTarget;
  reminderId?: string;
};

/** `api.buzz.reminders.create` — named by hand, see canvas-pane.tsx. */
const createRef = makeFunctionReference<"mutation", CreateArgs, unknown>(
  "buzz/reminders:create",
);

/**
 * A 32-hex `d` tag, minted here when the browser can.
 *
 * NIP-ER mandates 128 bits and `randomUUID()` only carries 122, so this is 16
 * bytes from the platform CSPRNG rather than a uuid. The server mints one when
 * this is absent (a mutation has no CSPRNG), so a browser without
 * `crypto.getRandomValues` is a supported state and not a broken one.
 */
function mintReminderId(): string | undefined {
  const source = globalThis.crypto;
  if (!source?.getRandomValues) return undefined;
  const bytes = source.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function RemindMeLater({
  scope,
  target,
  onDone,
}: {
  scope: ChatScope | null;
  /** The message this is about. Absent means a plain note reminder. */
  target?: RemindTarget;
  onDone?: () => void;
}) {
  const { toast } = useToast();
  const create = useMutation(createRef);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const now = useMemo(() => new Date(), []);
  const custom = parseCustomDateTime(date, time, new Date());

  const submit = useCallback(
    async (at: Date) => {
      if (!scope || busy) return;
      const trimmed = note.trim();
      if (!target && trimmed.length === 0) {
        toast("Write a note, or pick a message to be reminded about.", {
          kind: "error",
        });
        return;
      }
      setBusy(true);
      // Minted once and held: two calls to a CSPRNG produce two ids, and the
      // second would be the one that reached the server while the first was
      // the one this code read.
      const reminderId = mintReminderId();
      try {
        await create({
          ...scope,
          notBefore: Math.floor(at.getTime() / 1000),
          ...(trimmed ? { note: trimmed } : {}),
          ...(target ? { target } : {}),
          ...(reminderId ? { reminderId } : {}),
        });
        toast("Reminder set");
        setNote("");
        setDate("");
        setTime("");
        onDone?.();
      } catch (error) {
        toast(
          error instanceof Error ? error.message : "Failed to create reminder",
          { kind: "error" },
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, create, note, onDone, scope, target, toast],
  );

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        {TIME_PRESETS.map((preset) => (
          <Button
            key={preset.id}
            variant="secondary"
            className="w-full justify-start"
            disabled={busy}
            onClick={() => submit(preset.at(new Date()))}
          >
            {preset.label}
          </Button>
        ))}
      </div>

      <div className="space-y-2">
        <p className="chat-quiet text-xs uppercase tracking-wider">
          Custom date &amp; time
        </p>
        <div className="flex gap-2">
          <input
            type="date"
            aria-label="Reminder date"
            min={todayDateString(now)}
            value={date}
            onChange={(event) => setDate(event.target.value)}
            className="soft-field min-w-0 flex-1 text-sm"
          />
          <input
            type="time"
            aria-label="Reminder time"
            value={time}
            onChange={(event) => setTime(event.target.value)}
            className="soft-field min-w-0 flex-1 text-sm"
          />
        </div>
        <Button
          className="w-full"
          disabled={busy || custom === null}
          onClick={() => custom && submit(custom)}
        >
          Set reminder
        </Button>
      </div>

      <textarea
        aria-label="Reminder note"
        placeholder={target ? "Add a note (optional)" : "What should this remind you of?"}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        rows={2}
        className={cn("soft-field w-full resize-none text-sm")}
      />
    </div>
  );
}
