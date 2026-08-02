"use client";

// `/chat/settings` — the two things about *you* that Chat stores.
//
// Buzz keeps settings inside a sheet with a long list of sections. Ours has
// two, and they are the two the product actually has: what reaches you, and
// what other people see of you. Nothing else is here, because nothing else
// exists yet — a settings screen with a section that does nothing is the
// failure mode this product exists to replace, and the moderation queue keeps
// its own route (it is not somewhere you go, it is somewhere you are sent).
//
// One choice at a time. The section picker sits in the 52px chrome row so it
// lines up with a room's header, and exactly one section is on screen — which
// is also what keeps the document to one `h1`, since each panel already titles
// itself.
//
// Neither panel is composed here beyond that. `NotificationSettingsPanel`
// brings its own eight slots, its own permission handshake and its own
// no-save-button contract; `MyPresenceControl` brings the three preferences and
// the status editor. This file decides only where they sit.

import { useState } from "react";
import { cn } from "@/lib/utils";
import { NotificationSettingsPanel } from "@/components/chat/notifications";
import { MyPresenceControl } from "@/components/chat/presence";
import { useChatShell } from "./chat-shell";
import { ContentSurface } from "./surfaces";

const SECTIONS = [
  { id: "notifications", label: "Notifications" },
  { id: "presence", label: "Presence" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export function ChatSettingsScreen() {
  const { scope, scopeName, presence } = useChatShell();
  const [section, setSection] = useState<SectionId>("notifications");

  return (
    <ContentSurface>
      {/* The picker sits on the same left edge as the panel under it rather
          than on the window's, so the two read as one column instead of two
          things that happen to be on the same screen. */}
      <header className="flex h-13 shrink-0 items-center px-5 sm:px-8">
        <div className="mx-auto flex w-full max-w-2xl">
          <div className="segmented" role="tablist" aria-label="Settings section">
            {SECTIONS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={section === entry.id}
                onClick={() => setSection(entry.id)}
                className={cn(
                  "tap-target rounded-full px-3 py-1 text-xs font-medium",
                  section === entry.id && "segmented-on",
                )}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="chat-scroll min-h-0 flex-1 px-5 pb-8 pt-2 sm:px-8">
        {section === "notifications" ? (
          <NotificationSettingsPanel />
        ) : (
          <section className="mx-auto w-full max-w-2xl">
            <header className="mb-8">
              <h1 className="title-rule text-2xl font-bold tracking-tight">
                Presence
              </h1>
              <p className="mt-3 text-sm text-muted-foreground">
                {/* Said plainly because it is the one thing about presence
                    people get wrong: both halves belong to a community, so
                    "Appear offline" here does not hide you somewhere else. */}
                Your dot and your status belong to{" "}
                {scopeName || "this community"} — every community is answered
                separately.
              </p>
            </header>
            <div className="rounded-2xl bg-muted/20 p-4">
              <MyPresenceControl scope={scope} presence={presence} />
            </div>
          </section>
        )}
      </div>
    </ContentSurface>
  );
}
