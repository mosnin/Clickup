"use client";

// A room.
//
// Three bands, and the middle one is the only one that moves: header, a
// transcript that scrolls, a composer pinned to the bottom. That is the whole
// reason the shell pins the viewport — if the document scrolled, the composer
// would walk off the bottom of the screen and the room would become a page you
// scroll to the end of to reply.
//
// Both halves are real now. A pending message is not spliced in as a finished
// row — it is handed back as an event and travels the same projection as
// everything else, so grouping, dividers and the unread rule apply to it
// without a second code path deciding what a sending message looks like. See
// room-composer.tsx, which owns that conversion and nothing else does.
//
// One pane, three things that want it. Details, and now threads, both dock in
// `AuxPane`, and only one can be open — which is a decision rather than a
// limitation: two panes beside a room leaves the room narrower than either of
// them, and on a phone the pane is a sheet over the room, where "two" is not a
// layout at all. Opening a thread closes details and vice versa.

import { useCallback, useReducer, useState } from "react";
import { useUser } from "@clerk/nextjs";
import {
  Bot,
  Check,
  FileText,
  GitBranch,
  Hash,
  Lock,
  MoreHorizontal,
  NotebookText,
  PanelRight,
  SquareKanban,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";
import type { ChatChannelSummary } from "@/lib/buzz/channel-types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ChannelTranscript,
  MyPubkeyProvider,
  ThreadPane,
} from "@/components/chat/transcript";
import { ForumPostList } from "@/components/chat/forum";
import { CanvasPane } from "@/components/chat/canvas";
import { BranchPane } from "@/components/chat/projects";
import { WorkPane } from "@/components/chat/bridge";
import {
  HuddleBar,
  HuddleProvider,
  HuddleStartButton,
} from "@/components/chat/huddle";
import { TypingLine, useRoomTyping } from "@/components/chat/presence";
import {
  AgentWorkingLine,
  RoomAgentsPanel,
  useRoomWorkingSignal,
  type WorkingAgent,
} from "@/components/chat/agents";
import type { TypingEntry } from "@/lib/buzz/presence";
import type { TimelineEvent } from "@/lib/buzz/timeline";
import { useChannel, useChannels } from "./channel-data";
import { RoomComposer, applyPending, type PendingChange } from "./room-composer";
import { useChatShell } from "./chat-shell";
import { AuxPane, ContentSurface } from "./surfaces";
import { title } from "./sections";

/** What the auxiliary pane is showing. One at a time, on purpose. */
type Aux =
  | { kind: "none" }
  | { kind: "details" }
  | { kind: "canvas" }
  /**
   * The forge side of the room: the branch it is bound to, its patches, its
   * checks, its reviews and its merge (C9).
   *
   * It docks here rather than replacing the transcript because the whole idea is
   * that the two are the *same room* — the argument and the artefacts side by
   * side. And it is offered on every room rather than on rooms that are already
   * branches, because "any room can become the room for a branch" is the
   * feature; the pane's own empty state is how you bind one.
   */
  | { kind: "branch" }
  /**
   * The Work side of the room (C12): the project it is bound to, that
   * project's activity, and the fleet — read across the seam, never copied
   * into the log. It docks in the same pane for the same reason the branch
   * does: it is the *same room*, seen from the other dashboard.
   */
  | { kind: "work" }
  /**
   * The machines in the room (C6c): who is attached, what each is doing right
   * now, and the honest silence for one nobody has run a harness for.
   *
   * It docks here rather than sitting under Details because it is a live
   * surface — a roster with turns running in it — and Details is a table of
   * facts about the room. Folding it into that pane would put a moving thing
   * inside a still one and give it nowhere to breathe.
   */
  | { kind: "agents" }
  | { kind: "thread"; rootId: string };

/**
 * A forum room has two surfaces, and they are genuinely two.
 *
 * Buzz's forum channel has only the post view; ours keeps the transcript as
 * well, because a room where people work still needs somewhere to say "back in
 * ten" — and the distinction §5.1 draws is exactly that a post is meant to be
 * read later and a message is not. Two views, one room, and **neither one ever
 * shows the other's rows**: the post list projects kind 45001 and the transcript
 * projects the chat content kinds, and the two sets are disjoint. There is no
 * filter here to forget.
 *
 * Posts is the default, because a forum is a place you arrive to read.
 */
type ForumView = "posts" | "chat";

export function ChannelScreen({ channelId }: { channelId: string }) {
  const { channels, error } = useChannels();
  const channel = useChannel(channelId);
  const { scope, scopeName, selfPubkey } = useChatShell();
  const { user } = useUser();
  const selfName = user?.fullName ?? user?.username ?? "You";
  const [aux, setAux] = useState<Aux>({ kind: "none" });
  const [forumView, setForumView] = useState<ForumView>("posts");

  // The two live signals the band below the transcript draws. One hook per
  // room, never one per row — see `agents/index.ts` and `presence/index.ts`.
  const working = useRoomWorkingSignal(scope, channelId);
  const typing = useRoomTyping({
    scope,
    channelId,
    selfPubkey,
    selfName,
  });
  // Messages written but not yet acknowledged. A reducer rather than raw state
  // because three callbacks fire into it from the composer and a stale closure
  // over the previous list drops whichever send landed second.
  const [pending, dispatchPending] = useReducer(
    (list: readonly TimelineEvent[], change: PendingChange) =>
      applyPending(list, change),
    [] as readonly TimelineEvent[],
  );

  const openThread = useCallback(
    (rootId: string) => setAux({ kind: "thread", rootId }),
    [],
  );
  const closeAux = useCallback(() => setAux({ kind: "none" }), []);

  // Sending is also the moment to stop announcing that you are about to: the
  // message itself says it, and a "typing…" that outlives the message it was
  // about is the indicator people learn to disbelieve.
  const { notifyMessageSent } = typing;
  const onPending = useCallback(
    (change: PendingChange) => {
      if (change.type === "add") notifyMessageSent();
      dispatchPending(change);
    },
    [notifyMessageSent],
  );

  if (channels === undefined && !error) {
    return (
      <ContentSurface>
        <div className="h-13 shrink-0 px-5" />
        <div className="min-h-0 flex-1" />
      </ContentSurface>
    );
  }

  if (!channel) {
    return (
      <ContentSurface>
        <div className="flex min-h-0 flex-1 items-center justify-center p-8">
          <div className="max-w-sm">
            <h1 className="text-lg font-semibold">Room not found</h1>
            <p className="chat-quiet mt-2 text-sm">
              {/* The likeliest cause by a distance, and the one nobody guesses:
                  a room belongs to one community, and you are standing in
                  another. Naming it beats a generic 404. */}
              This room is not in {scopeName || "this community"}. It may belong
              to another community — pick one from the rail.
            </p>
          </div>
        </div>
      </ContentSurface>
    );
  }

  const label = title(channel);
  const isDirect = channel.kind === "dm" || channel.kind === "group_dm";
  const roomLabel = isDirect ? label : `#${channel.name}`;
  const isForum = channel.kind === "forum";
  const showingPosts = isForum && forumView === "posts";

  return (
    // One subscription for "who am I", mounted above both the transcript and
    // the thread pane. Every row asks whether a message is the reader's own;
    // forty rows each asking the server is forty subscriptions for one string.
    <MyPubkeyProvider>
      {/* One huddle session per room (`huddle/index.ts` step 1). It wraps the
          aux panes as well as the transcript, because a 48100 row drawn in a
          thread is the same call as the one in the room and must read from the
          same folded snapshot. */}
      <HuddleProvider
        scope={scope}
        channelId={channelId}
        selfPubkey={selfPubkey}
        selfName={selfName}
      >
        <ContentSurface>
          {/* `@container`: the four secondary toggles below answer "is THIS
              header wide enough", not "is the viewport" — a room narrowed by
              a docked aux pane folds them exactly as a phone would. */}
          <header className="@container flex h-13 shrink-0 items-center gap-2 px-5">
            <RoomGlyph channel={channel} />
            <h1 className="shrink-0 truncate text-compact font-semibold">
              {isDirect ? label : channel.name}
            </h1>
            {channel.topic ? (
              <p className="chat-quiet min-w-0 flex-1 truncate border-l pl-3 text-xs chat-divider">
                {channel.topic}
              </p>
            ) : (
              <span className="min-w-0 flex-1" />
            )}
            {isForum ? (
              <div
                className="segmented shrink-0"
                role="tablist"
                aria-label="Forum view"
              >
                {(["posts", "chat"] as const).map((view) => (
                  <button
                    key={view}
                    type="button"
                    role="tab"
                    aria-selected={forumView === view}
                    onClick={() => setForumView(view)}
                    className={cn(
                      "tap-target rounded-full px-3 py-1 text-xs font-medium capitalize",
                      forumView === view && "segmented-on",
                    )}
                  >
                    {view}
                  </button>
                ))}
              </div>
            ) : null}
            <span className="chat-quiet flex shrink-0 items-center gap-1 text-xs">
              <Users aria-hidden className="size-3.5" />
              {channel.memberCount}
            </span>
            {/* Start a call, or join the one already running — one control for
                both, because from here it is one intention. It returns null once
                you are in, at which point the bar above the composer is where a
                call lives. */}
            <HuddleStartButton className="shrink-0" />
            {/* The room's machines. An affordance, not an ornament: the same
                toggle contract as every other pane button beside it. Stays
                inline at every width — the one secondary toggle that does not
                fold away below, alongside Huddle above. */}
            <button
              type="button"
              onClick={() =>
                setAux((current) =>
                  current.kind === "agents" ? { kind: "none" } : { kind: "agents" },
                )
              }
              aria-pressed={aux.kind === "agents"}
              aria-label="Agents"
              className="chat-icon-button tap-target"
            >
              <Bot aria-hidden className="size-4" />
            </button>

            {/* Canvas / Branch / Work / Details: four toggles, drawn twice —
                once inline for a header with the room to spare, once folded
                into one menu for a header that doesn't. Same `aux` state,
                same handlers, either way — only which markup is on screen
                changes. The wrapper spans (not the buttons) carry the
                visibility utilities: `.chat-icon-button` sets its own
                `display` outside any Tailwind layer, which outranks a layered
                utility placed on that same element, so hiding one of these
                buttons has to happen an element up. */}
            <span className="hidden @lg:contents">
              {/* The canvas — one markdown document per room, docked in the
                  same pane threads and details use. Only one pane at a time,
                  which is the shell's rule and not this screen's: two panes
                  beside a room leave the room narrower than either of them. */}
              <button
                type="button"
                onClick={() =>
                  setAux((current) =>
                    current.kind === "canvas" ? { kind: "none" } : { kind: "canvas" },
                  )
                }
                aria-pressed={aux.kind === "canvas"}
                aria-label="Canvas"
                className="chat-icon-button tap-target"
              >
                <NotebookText aria-hidden className="size-4" />
              </button>
              {!isDirect ? (
                <button
                  type="button"
                  onClick={() =>
                    setAux((current) =>
                      current.kind === "branch" ? { kind: "none" } : { kind: "branch" },
                    )
                  }
                  aria-pressed={aux.kind === "branch"}
                  aria-label="Branch"
                  className="chat-icon-button tap-target"
                >
                  <GitBranch aria-hidden className="size-4" />
                </button>
              ) : null}
              {!isDirect ? (
                <button
                  type="button"
                  onClick={() =>
                    setAux((current) =>
                      current.kind === "work" ? { kind: "none" } : { kind: "work" },
                    )
                  }
                  aria-pressed={aux.kind === "work"}
                  aria-label="Work"
                  className="chat-icon-button tap-target"
                >
                  <SquareKanban aria-hidden className="size-4" />
                </button>
              ) : null}
              <button
                type="button"
                onClick={() =>
                  setAux((current) =>
                    current.kind === "details" ? { kind: "none" } : { kind: "details" },
                  )
                }
                aria-pressed={aux.kind === "details"}
                aria-label="Room details"
                className="chat-icon-button tap-target"
              >
                <PanelRight aria-hidden className="size-4" />
              </button>
            </span>

            {/* The same four toggles, below the threshold: one trigger, one
                menu. Each item keeps its own handler and a visible label —
                the Check mark carries the "already open" state the inline
                buttons say with `aria-pressed`, the same convention the
                community switcher above this room uses for "which one is
                current". */}
            <span className="@lg:hidden">
              <DropdownMenu>
                <DropdownMenuTrigger
                  type="button"
                  aria-label="More room panels"
                  className="chat-icon-button tap-target"
                >
                  <MoreHorizontal aria-hidden className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem
                    onSelect={() =>
                      setAux((current) =>
                        current.kind === "canvas" ? { kind: "none" } : { kind: "canvas" },
                      )
                    }
                  >
                    <NotebookText aria-hidden className="size-4" />
                    <span className="min-w-0 flex-1">Canvas</span>
                    {aux.kind === "canvas" ? (
                      <Check aria-hidden className="size-4 shrink-0" />
                    ) : null}
                  </DropdownMenuItem>
                  {!isDirect ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        setAux((current) =>
                          current.kind === "branch" ? { kind: "none" } : { kind: "branch" },
                        )
                      }
                    >
                      <GitBranch aria-hidden className="size-4" />
                      <span className="min-w-0 flex-1">Branch</span>
                      {aux.kind === "branch" ? (
                        <Check aria-hidden className="size-4 shrink-0" />
                      ) : null}
                    </DropdownMenuItem>
                  ) : null}
                  {!isDirect ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        setAux((current) =>
                          current.kind === "work" ? { kind: "none" } : { kind: "work" },
                        )
                      }
                    >
                      <SquareKanban aria-hidden className="size-4" />
                      <span className="min-w-0 flex-1">Work</span>
                      {aux.kind === "work" ? (
                        <Check aria-hidden className="size-4 shrink-0" />
                      ) : null}
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem
                    onSelect={() =>
                      setAux((current) =>
                        current.kind === "details" ? { kind: "none" } : { kind: "details" },
                      )
                    }
                  >
                    <PanelRight aria-hidden className="size-4" />
                    <span className="min-w-0 flex-1">Room details</span>
                    {aux.kind === "details" ? (
                      <Check aria-hidden className="size-4 shrink-0" />
                    ) : null}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </header>

          {showingPosts ? (
            // The forum's own surface: cards, its own composer, its own sort. It
            // does not mount the transcript, and the transcript never draws a
            // post — see `ForumView` above.
            <ForumPostList scope={scope} channel={channel} />
          ) : (
            <>
              {/* The transcript. The only scroller on the screen. */}
              <ChannelTranscript
                scope={scope}
                channelId={channelId}
                channelLabel={roomLabel}
                onOpenThread={openThread}
                pendingEvents={pending}
              />

              {/* The composer. Pinned — the one band that never scrolls. */}
              <div className="shrink-0 px-5 pb-4 pt-1">
                {working.subscriptions}
                <RoomActivityBand
                  working={working.working}
                  now={working.now}
                  typists={typing.typists}
                />
                <RoomComposer
                  scope={scope}
                  channel={channel}
                  channelLabel={roomLabel}
                  onPending={onPending}
                  onTyping={typing.notifyTyping}
                />
              </div>
            </>
          )}
        </ContentSurface>

        {aux.kind === "details" ? (
          <AuxPane title="Details" onClose={closeAux}>
            <RoomDetails channel={channel} />
          </AuxPane>
        ) : aux.kind === "canvas" ? (
          <AuxPane title="Canvas" onClose={closeAux}>
            <CanvasPane scope={scope} channelId={channelId} />
          </AuxPane>
        ) : aux.kind === "branch" ? (
          <AuxPane title="Branch" onClose={closeAux}>
            <BranchPane scope={scope} channelId={channelId} />
          </AuxPane>
        ) : aux.kind === "work" ? (
          <AuxPane title="Work" onClose={closeAux}>
            <WorkPane scope={scope} channelId={channelId} />
          </AuxPane>
        ) : aux.kind === "agents" ? (
          <AuxPane title="Agents" onClose={closeAux}>
            {/* It reads its own membership — `buzz/agents:attachable` answers
                "who is here" and "who could be" as one list — so there is
                nothing to thread through and no way for the picker to offer
                somebody the list above it is already showing. */}
            <RoomAgentsPanel
              scope={scope}
              channelId={channelId}
              roomLabel={roomLabel}
            />
          </AuxPane>
        ) : aux.kind === "thread" ? (
          <AuxPane title="Thread" onClose={closeAux}>
            <ThreadPane
              scope={scope}
              channelId={channelId}
              rootId={aux.rootId}
            />
          </AuxPane>
        ) : null}
      </HuddleProvider>
    </MyPubkeyProvider>
  );
}

/**
 * The band between the transcript and the composer.
 *
 * Three things want this strip and each is a version of "somebody is about to
 * speak": a call in progress, an agent taking a turn, a person typing. Stacked,
 * they are three rows of movement under a transcript somebody is trying to
 * read — and two of them are the same sentence about two kinds of colleague.
 *
 * So the band is a bar and exactly one line. The huddle bar is its own object
 * (a call is a place, with controls, not a sentence) and it is absent unless a
 * call is up. Under it there is one line, always 20px tall whether or not it
 * has anything to say, and a machine at work outranks a person typing: an
 * agent's answer arrives whole a few seconds from now and a person's arrives
 * when they finish, so it is the one that changes whether you wait. Both lines
 * reserve the same height, so the transcript never moves when the band changes
 * its mind.
 */
function RoomActivityBand({
  working,
  now,
  typists,
}: {
  working: readonly WorkingAgent[];
  now: number;
  typists: readonly TypingEntry[];
}) {
  return (
    <>
      <HuddleBar className="mb-2" />
      {working.length > 0 ? (
        <AgentWorkingLine working={working} now={now} />
      ) : (
        <TypingLine typists={typists} />
      )}
    </>
  );
}

function RoomGlyph({ channel }: { channel: ChatChannelSummary }) {
  if (channel.kind === "dm" || channel.kind === "group_dm") return null;
  const Glyph =
    channel.kind === "forum"
      ? FileText
      : channel.visibility === "private"
        ? Lock
        : Hash;
  return <Glyph aria-hidden className="chat-quiet size-4 shrink-0" />;
}

/**
 * What the auxiliary pane shows today.
 *
 * Every field here is one the channel contract already carries, which is why
 * this pane is real: it describes the room from the same row the sidebar draws.
 */
function RoomDetails({ channel }: { channel: ChatChannelSummary }) {
  const rows: [string, string][] = [
    ["Name", `#${channel.name}`],
    ["Kind", KIND_LABEL[channel.kind]],
    ["Visibility", channel.visibility === "private" ? "Private" : "Public"],
    ["Members", String(channel.memberCount)],
    [
      "Last activity",
      channel.lastActivityAt ? timeAgo(channel.lastActivityAt) : "Never",
    ],
    ["Notifications", channel.muted ? "Muted" : "On"],
  ];
  if (channel.ttlSeconds) {
    rows.push(["Ephemeral", `Disappears after ${channel.ttlSeconds}s idle`]);
  }

  return (
    <div className="space-y-4 pb-2">
      {channel.description ? (
        <p className="text-sm">{channel.description}</p>
      ) : null}
      {channel.topic ? <p className="chat-quiet text-sm">{channel.topic}</p> : null}
      <dl className="space-y-1 text-sm">
        {rows.map(([term, value]) => (
          <div key={term} className="flex gap-3 py-1">
            <dt className="chat-quiet w-28 shrink-0 text-xs">{term}</dt>
            <dd className="min-w-0 flex-1 truncate">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const KIND_LABEL: Record<ChatChannelSummary["kind"], string> = {
  channel: "Channel",
  dm: "Direct message",
  group_dm: "Group message",
  forum: "Forum",
};
