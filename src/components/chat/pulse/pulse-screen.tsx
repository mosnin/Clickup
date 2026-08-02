"use client";

// Pulse: the community's own timeline.
//
// The screen is three things stacked and nothing else: a tab bar, a composer
// (on the tabs that have one), and a list. Everything that decides *what* is in
// the list is `src/lib/buzz/pulse.ts` — which tab selects which authors, which
// notes fold into one agent card, what a reaction pill says. None of that is
// here, so none of it needs a browser to be tested.
//
// Two structural choices worth stating:
//
//   • **The tab is in the URL** (`?tab=`). A feed you cannot link to is a feed
//     you have to describe over a call, and it also means going back does not
//     dump you on Everyone.
//   • **The composer is sticky and the list scrolls under it.** Pulse is a
//     place you post from, not only one you read; a composer that scrolls away
//     turns "say something" into "scroll to the top first".
//
// Spec: docs/buzz-parity/03-workflows-projects.md §3.

import { useCallback, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation } from "convex/react";
import { Stagger, StaggerItem } from "@/components/motion";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import {
  PULSE_TABS,
  normalizePulseTab,
  pulseEmptyState,
  type PulseTab,
} from "@/lib/buzz/pulse";
import { useChatShell } from "../shell/chat-shell";
import { ContentSurface } from "../shell/surfaces";
import { AgentActivityCard, NoteCard } from "./note-card";
import { PulseBoundary, pulsePost, pulseUpvote, usePulse } from "./pulse-data";

export function PulseScreen() {
  return (
    <ContentSurface>
      <PulseBoundary
        fallback={(message) => (
          // The reason, not an apology: "Could not find public function
          // buzz/pulse:feed" is the sentence that says what is missing.
          <div className="chat-scroll min-h-0 flex-1">
            <div className="mx-auto w-full max-w-2xl px-5 py-8">
              <h1 className="text-2xl font-bold tracking-tight">Pulse</h1>
              <div className="title-rule" />
              <p role="status" className="mt-6 text-sm text-danger">
                {message}
              </p>
            </div>
          </div>
        )}
      >
        <PulseBody />
      </PulseBoundary>
    </ContentSurface>
  );
}

function PulseBody() {
  const router = useRouter();
  const params = useSearchParams();
  const tab = normalizePulseTab(params.get("tab"));
  const { scope, scopeName } = useChatShell();
  const { feed, raw, audience, names } = usePulse(scope, tab);
  const { toast } = useToast();

  const post = useMutation(pulsePost);
  const upvote = useMutation(pulseUpvote);

  const setTab = useCallback(
    (next: PulseTab) => {
      const search = new URLSearchParams(params.toString());
      if (next === "everyone") search.delete("tab");
      else search.set("tab", next);
      const query = search.toString();
      router.replace(query ? `/chat/pulse?${query}` : "/chat/pulse", { scroll: false });
    },
    [params, router],
  );

  const onUpvote = useCallback(
    async (noteId: string, on: boolean) => {
      if (!scope) return;
      try {
        await upvote({ ...scope, noteId, on });
      } catch (error) {
        // The server's reason, verbatim — a restriction says so in words the
        // reader can act on, and anything else is a real failure.
        toast(reasonOf(error), { kind: "error" });
      }
    },
    [scope, toast, upvote],
  );

  const spec = PULSE_TABS.find((t) => t.id === tab);
  const canWrite = audience.viewerPubkey !== "";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 px-5 pb-2 pt-6 sm:px-8">
        <div className="mx-auto w-full max-w-2xl">
          <h1 className="text-2xl font-bold tracking-tight">Pulse</h1>
          <div className="title-rule" />
          <p className="chat-quiet mt-3 text-sm">
            {scopeName ? `What is happening in ${scopeName}.` : "What is happening."}
          </p>

          {/* A horizontally scrollable pill row: six tabs do not fit at 390px,
              and a wrapped tab bar changes height when the badge appears. */}
          <div
            role="tablist"
            aria-label="Pulse feeds"
            className="segmented mt-4 flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {PULSE_TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={entry.id === tab}
                onClick={() => setTab(entry.id)}
                className={cn(
                  "tap-target shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-xs",
                  entry.id === tab && "segmented-on font-semibold",
                )}
              >
                {entry.label}
                {entry.id === "agents" && (raw?.agentCount ?? 0) > 0 ? (
                  <span className="chat-badge ml-1.5" data-size="sm">
                    {raw?.agentCount}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      </header>

      {tab === "search" ? (
        <SearchHero />
      ) : (
        <div className="chat-scroll min-h-0 flex-1 px-5 pb-6 sm:px-8">
          <div className="mx-auto w-full max-w-2xl">
            {spec?.composer && scope ? (
              <div className="sticky top-0 z-10 -mx-1 bg-background/95 px-1 py-2 backdrop-blur-sm">
                <Composer
                  disabled={!canWrite}
                  onSubmit={async (body) => {
                    try {
                      await post({ ...scope, body });
                      return true;
                    } catch (error) {
                      toast(reasonOf(error), { kind: "error" });
                      return false;
                    }
                  }}
                />
              </div>
            ) : null}

            {feed === undefined ? <FeedSkeleton /> : null}

            {feed && feed.notes.length === 0 && feed.groups.length === 0 ? (
              <p className="chat-quiet py-8 text-sm">
                {pulseEmptyState(tab, {
                  agentCount: raw?.agentCount ?? 0,
                  hasContacts: (raw?.contactPubkeys.length ?? 0) > 0,
                })}
              </p>
            ) : null}

            {feed ? (
              <Stagger className="space-y-2 py-2">
                {feed.groups.map((group) => (
                  <StaggerItem key={group.key}>
                    <AgentActivityCard group={group} names={names} />
                  </StaggerItem>
                ))}
                {feed.notes.map((note) => (
                  <StaggerItem key={note.id}>
                    <NoteCard
                      note={note}
                      names={names}
                      reaction={feed.reactions.get(note.id)}
                      onUpvote={onUpvote}
                      canUpvote={canWrite}
                    />
                  </StaggerItem>
                ))}
              </Stagger>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Search is not wired to a backend (§3.1), and this says so rather than
 * pretending.
 *
 * A box that accepts typing and never answers is worse than a box that states
 * its own state: the first teaches people the product is broken, the second
 * teaches them it is unfinished.
 */
function SearchHero() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-5 pb-16">
      <div className="w-full max-w-md text-center">
        <p className="text-lg font-semibold">What are you looking for?</p>
        <p className="chat-quiet mt-2 text-sm">
          Pulse search is not connected yet. Use ⌘K to search rooms, messages and
          pages in the meantime.
        </p>
      </div>
    </div>
  );
}

function Composer({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (body: string) => Promise<boolean>;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    const ok = await onSubmit(text);
    setBusy(false);
    // The box is cleared only on success. A composer that empties itself on a
    // refusal has thrown away what somebody wrote.
    if (ok) setBody("");
  }

  return (
    <form
      className="bento flex items-end gap-2 rounded-2xl px-3 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <textarea
        value={body}
        disabled={disabled}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          // Enter posts, Shift+Enter is a newline — the same contract the room
          // composer uses, so one habit works in both places.
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
        rows={1}
        placeholder={disabled ? "Open Chat once to post" : "What's on your mind?"}
        aria-label="Write a note"
        className="soft-field max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none"
      />
      <button
        type="submit"
        disabled={disabled || busy || body.trim().length === 0}
        className="tap-target shrink-0 rounded-full bg-foreground px-3 py-1.5 text-xs font-semibold text-background disabled:opacity-40"
      >
        Post
      </button>
    </form>
  );
}

function FeedSkeleton() {
  return (
    <div className="space-y-2 py-2" aria-hidden>
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="bento flex gap-3 rounded-2xl px-4 py-3">
          <span className="size-8 shrink-0 rounded-full bg-muted" />
          <span className="flex-1 space-y-2">
            <span className="block h-3 w-24 rounded bg-muted" />
            <span className="block h-3 w-full rounded bg-muted" />
          </span>
        </div>
      ))}
    </div>
  );
}

/** The server's own sentence, or a last resort. Never a generic apology. */
function reasonOf(error: unknown): string {
  const data = (error as { data?: unknown })?.data;
  if (typeof data === "string" && data.length > 0) return data;
  return error instanceof Error ? error.message : "That did not work";
}
