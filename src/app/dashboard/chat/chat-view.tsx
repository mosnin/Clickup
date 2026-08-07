"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useAction, useMutation, useQuery } from "convex/react";
import { Hash, Plus, Radio } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Monogram } from "@/components/dashboard/monogram";
import { InlineCreate } from "@/components/dashboard/inline-create";
import { MessageBody } from "@/components/dashboard/message-body";
import { ChatComposer, type ChatCommand } from "@/components/dashboard/chat/composer";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";
import { timeAgo } from "@/lib/time";
import {
  TYPING_THROTTLE_MS,
  TYPING_TTL_MS,
  useAblyChannel,
} from "@/lib/use-ably-channel";
import { cn } from "@/lib/utils";

// Chat: the discussion surface for humans and agents.
//
// Full-bleed on purpose. A conversation is a place you sit in, not a panel you
// glance at — the same reason a page fills the column rather than living in a
// card. It cancels the dashboard shell's padding and owns the viewport, with
// its own scroll region for the transcript so the composer never moves.
//
// Convex drives the transcript; Ably drives the parts a query can't answer
// (who is typing, who is here). When Ably isn't configured the room still
// works — it just stops telling you someone is mid-sentence.

const TRANSCRIPT_LIMIT = 200;

export function ChatView() {
  const router = useRouter();
  const params = useSearchParams();
  const { user } = useUser();
  const { toast } = useToast();

  const scopes = useQuery(api.chat.scopesForCurrentUser, {});
  const activeChannelId = params.get("channel") as Id<"channels"> | null;

  // The scope follows the open channel when there is one, so a deep link from
  // the inbox lands in the right workspace without a second click.
  const openThread = useQuery(
    api.chat.thread,
    activeChannelId ? { channelId: activeChannelId, limit: TRANSCRIPT_LIMIT } : "skip",
  );
  const scopeFromUrl = params.get("scope");
  const scope = useMemo(() => {
    if (openThread) {
      return {
        scopeType: openThread.channel.scopeType,
        scopeId: openThread.channel.scopeId,
      };
    }
    if (scopeFromUrl) {
      const [scopeType, ...rest] = scopeFromUrl.split(":");
      if (scopeType === "user" || scopeType === "workspace") {
        return { scopeType, scopeId: rest.join(":") } as const;
      }
    }
    const first = scopes?.[0];
    return first
      ? ({ scopeType: first.scopeType, scopeId: first.scopeId } as const)
      : null;
  }, [openThread, scopeFromUrl, scopes]);

  const channels = useQuery(
    api.chat.channels,
    scope ? { scopeType: scope.scopeType, scopeId: scope.scopeId } : "skip",
  );
  const createChannel = useMutation(api.channels.create);

  // Pick the first channel automatically: an empty pane beside a populated
  // rail is a dead end.
  useEffect(() => {
    if (activeChannelId || !channels || channels.length === 0 || !scope) return;
    router.replace(
      `/dashboard/chat?channel=${channels[0].channelId}`,
    );
  }, [activeChannelId, channels, router, scope]);

  return (
    <div className="-mx-4 -my-6 flex h-svh min-w-0 sm:-mx-6">
      <ChannelRail
        scopes={scopes ?? []}
        scope={scope}
        channels={channels ?? []}
        activeChannelId={activeChannelId}
        onCreate={async (name) => {
          if (!scope) return;
          try {
            const channelId = await createChannel({
              scopeType: scope.scopeType,
              scopeId: scope.scopeId,
              name,
            });
            router.replace(`/dashboard/chat?channel=${channelId}`);
          } catch (e) {
            toast(errorMessage(e, "Couldn't create the channel"), {
              kind: "error",
            });
          }
        }}
      />
      {activeChannelId ? (
        <Room
          key={activeChannelId}
          channelId={activeChannelId}
          myName={
            user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? "You"
          }
          myId={user?.id ?? ""}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center p-8">
          <p className="max-w-sm text-center text-sm text-muted-foreground">
            Channels are where a decision gets made in the open — people and
            agents in the same thread, with the work linkable from inside the
            sentence.
          </p>
        </div>
      )}
    </div>
  );
}

function ChannelRail({
  scopes,
  scope,
  channels,
  activeChannelId,
  onCreate,
}: {
  scopes: { scopeType: "user" | "workspace"; scopeId: string; name: string }[];
  scope: { scopeType: "user" | "workspace"; scopeId: string } | null;
  channels: {
    channelId: string;
    name: string;
    topic?: string;
    unread: number;
    lastMessageAt?: number;
    lastMessagePreview?: string;
    lastMessageByName?: string;
  }[];
  activeChannelId: string | null;
  onCreate: (name: string) => void;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);

  return (
    <aside className="flex w-64 flex-shrink-0 flex-col border-r border-border bg-card max-md:hidden">
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <SidebarTrigger className="md:hidden" />
        <h1 className="flex-1 text-sm font-semibold">Chat</h1>
        <button
          type="button"
          aria-label="New channel"
          onClick={() => setCreating(true)}
          className="tap-target inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {scopes.length > 1 && (
        <div className="px-3 pb-2">
          <div className="segmented w-full">
            {scopes.map((s) => {
              const on =
                scope?.scopeType === s.scopeType && scope?.scopeId === s.scopeId;
              return (
                <button
                  key={`${s.scopeType}:${s.scopeId}`}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    router.replace(
                      `/dashboard/chat?scope=${s.scopeType}:${s.scopeId}`,
                    )
                  }
                  className={cn(
                    "min-w-0 flex-1 truncate px-2 py-1 text-tiny",
                    on && "segmented-on",
                  )}
                >
                  {s.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {creating && (
          <div className="px-1 pb-2">
            <InlineCreate
              placeholder="channel-name"
              onSubmit={(name) => {
                onCreate(name);
                setCreating(false);
              }}
              onCancel={() => setCreating(false)}
            />
          </div>
        )}
        {channels.length === 0 && !creating ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            No channels yet. The first one is usually the thing you keep
            explaining twice.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {channels.map((c) => {
              const on = c.channelId === activeChannelId;
              return (
                <li key={c.channelId}>
                  <button
                    type="button"
                    onClick={() =>
                      router.replace(`/dashboard/chat?channel=${c.channelId}`)
                    }
                    className={cn(
                      "flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left",
                      on ? "bg-accent" : "hover:bg-accent/60",
                    )}
                  >
                    <Hash className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate text-sm",
                            c.unread > 0 && "font-semibold",
                          )}
                        >
                          {c.name}
                        </span>
                        {c.unread > 0 && (
                          <span className="flex-shrink-0 rounded-full bg-foreground px-1.5 text-micro font-medium text-background">
                            {c.unread > 99 ? "99+" : c.unread}
                          </span>
                        )}
                      </span>
                      {c.lastMessagePreview && (
                        <span className="mt-0.5 block truncate text-tiny text-muted-foreground">
                          {c.lastMessageByName
                            ? `${c.lastMessageByName}: ${c.lastMessagePreview}`
                            : c.lastMessagePreview}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

function Room({
  channelId,
  myName,
  myId,
}: {
  channelId: Id<"channels">;
  myName: string;
  myId: string;
}) {
  const { toast } = useToast();
  const thread = useQuery(api.chat.thread, {
    channelId,
    limit: TRANSCRIPT_LIMIT,
  });
  const send = useMutation(api.messages.create);
  const markRead = useMutation(api.chat.markRead);
  const setTopic = useMutation(api.chat.setTopic);
  const createTask = useMutation(api.tasks.create);
  const createPage = useMutation(api.pages.create);
  const signal = useAction(api.realtime.chatSignal);

  const scope = thread?.channel;
  const mentionables = useQuery(
    api.pages.mentionableActors,
    scope ? { scopeType: scope.scopeType, scopeId: scope.scopeId } : "skip",
  );
  const refTargets = useQuery(
    api.chat.referenceTargets,
    scope ? { scopeType: scope.scopeType, scopeId: scope.scopeId } : "skip",
  );

  // Every reference across the whole transcript resolved in one query, rather
  // than one query per chip.
  const allRefs = useMemo(() => {
    const seen = new Map<string, { kind: string; id: string; label: string }>();
    for (const m of thread?.messages ?? []) {
      for (const r of m.refs) seen.set(`${r.kind}:${r.id}`, r);
    }
    return [...seen.values()];
  }, [thread?.messages]);
  const resolved = useQuery(
    api.chat.resolveRefs,
    allRefs.length > 0 ? { refs: allRefs } : "skip",
  );

  // ── Ably: typing and presence ──
  const [typing, setTyping] = useState<Record<string, number>>({});
  const status = useAblyChannel(channelId, (event) => {
    const who = event.data.name;
    if (!who || who === myName) return;
    if (event.name === "typing") {
      setTyping((prev) => ({ ...prev, [who]: Date.now() }));
    }
  });
  // Expire stale indicators locally: the signal is a heartbeat, and whoever
  // sent it may have closed the tab rather than stopped typing.
  useEffect(() => {
    const timer = setInterval(() => {
      setTyping((prev) => {
        const now = Date.now();
        const next = Object.fromEntries(
          Object.entries(prev).filter(([, at]) => now - at < TYPING_TTL_MS),
        );
        return Object.keys(next).length === Object.keys(prev).length
          ? prev
          : next;
      });
    }, 1_000);
    return () => clearInterval(timer);
  }, []);

  const lastTypingSent = useRef(0);
  function announceTyping() {
    const now = Date.now();
    if (now - lastTypingSent.current < TYPING_THROTTLE_MS) return;
    lastTypingSent.current = now;
    void signal({ channelId, kind: "typing", name: myName }).catch(() => {});
  }

  // Reading the room marks it read — the badge should clear because you
  // looked, not because you clicked something.
  useEffect(() => {
    if (!thread) return;
    void markRead({ channelId }).catch(() => {});
  }, [channelId, markRead, thread?.messages.length, thread]);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [thread?.messages.length]);

  const commands: ChatCommand[] = useMemo(() => {
    if (!scope) return [];
    return [
      {
        name: "task",
        hint: "create a task",
        run: async (argument) => {
          if (!argument) {
            toast("Say what the task is: /task Fix the header", {
              kind: "error",
            });
            return;
          }
          // Needs a list to live in; the first list in the reference set is
          // the pragmatic default and the message says which one.
          const list = (refTargets ?? []).find((r) => r.kind === "list");
          if (!list) {
            toast("Make a list first — a task needs somewhere to live", {
              kind: "error",
            });
            return;
          }
          try {
            const taskId = await createTask({
              listId: list.id as Id<"lists">,
              title: argument,
            });
            await send({
              parentType: "channel",
              parentId: channelId,
              body: `Created #[${argument.slice(0, 60)}](task:${taskId}) in #[${list.label}](list:${list.id})`,
            });
          } catch (e) {
            toast(errorMessage(e, "Couldn't create the task"), {
              kind: "error",
            });
          }
        },
      },
      {
        name: "page",
        hint: "start a page and link it",
        run: async (argument) => {
          if (!argument) {
            toast("Give the page a name: /page Launch plan", { kind: "error" });
            return;
          }
          try {
            const pageId = await createPage({
              scopeType: scope.scopeType,
              scopeId: scope.scopeId,
              title: argument,
            });
            await send({
              parentType: "channel",
              parentId: channelId,
              body: `Started #[${argument.slice(0, 60)}](page:${pageId})`,
            });
          } catch (e) {
            toast(errorMessage(e, "Couldn't create the page"), {
              kind: "error",
            });
          }
        },
      },
      {
        name: "topic",
        hint: "set what this channel is for",
        run: async (argument) => {
          try {
            await setTopic({ channelId, topic: argument });
            toast(argument ? "Topic set" : "Topic cleared");
          } catch (e) {
            toast(errorMessage(e, "Couldn't set the topic"), { kind: "error" });
          }
        },
      },
    ];
  }, [
    channelId,
    createPage,
    createTask,
    refTargets,
    scope,
    send,
    setTopic,
    toast,
  ]);

  if (thread === undefined) {
    return (
      <div className="flex min-w-0 flex-1 flex-col gap-3 p-6">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-14 animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
    );
  }
  if (thread === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-sm text-muted-foreground">
          That channel isn&apos;t available — it may have been deleted.
        </p>
      </div>
    );
  }

  const typingNames = Object.keys(typing);

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <SidebarTrigger className="md:hidden" />
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <Hash className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="truncate">{thread.channel.name}</span>
          </h2>
          {thread.channel.topic && (
            <p className="truncate text-xs text-muted-foreground">
              {thread.channel.topic}
            </p>
          )}
        </div>
        {/* Honest about the transport: "live" means Ably is carrying the
            ephemeral signals, not that messages need it. */}
        <span
          title={
            status === "live"
              ? "Live: typing indicators are on"
              : "Messages are live; typing indicators are unavailable"
          }
          className={cn(
            "flex flex-shrink-0 items-center gap-1 text-micro uppercase tracking-wider",
            status === "live" ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <Radio className="h-3 w-3" />
          {status === "live" ? "live" : "convex"}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {thread.truncated && (
          <p className="pb-4 text-center text-tiny text-muted-foreground">
            Showing the most recent {TRANSCRIPT_LIMIT} messages.
          </p>
        )}
        {thread.messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Nothing here yet. Type <code className="font-mono">#</code> to point
            at a project or page, or <code className="font-mono">@</code> to
            bring someone in.
          </p>
        ) : (
          <ul className="space-y-4">
            {thread.messages.map((m, i) => {
              // Group consecutive messages from the same author: a name and
              // avatar per line turns a conversation into a list.
              const previous = thread.messages[i - 1];
              const grouped =
                previous?.authorId === m.authorId &&
                m.createdAt - previous.createdAt < 5 * 60 * 1000;
              return (
                <li
                  key={m.messageId}
                  className={cn("flex gap-3", grouped && "-mt-3")}
                >
                  <span className="w-7 flex-shrink-0">
                    {!grouped && (
                      <Monogram name={m.authorName} size="sm" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    {!grouped && (
                      <p className="flex items-baseline gap-2">
                        <span className="text-sm font-medium">
                          {m.authorName}
                        </span>
                        {m.authorIsAgent && (
                          <span className="text-micro uppercase tracking-wider text-muted-foreground">
                            agent
                          </span>
                        )}
                        <span className="text-tiny text-muted-foreground">
                          {timeAgo(m.createdAt)}
                        </span>
                      </p>
                    )}
                    <MessageBody
                      body={m.body}
                      resolved={resolved ?? undefined}
                      className={cn(
                        m.authorId === myId ? "text-foreground" : undefined,
                      )}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-border px-4 py-3">
        <div className="h-4">
          {typingNames.length > 0 && (
            <p className="text-tiny text-muted-foreground">
              {typingNames.length === 1
                ? `${typingNames[0]} is typing…`
                : `${typingNames.length} people are typing…`}
            </p>
          )}
        </div>
        <ChatComposer
          mentionables={(mentionables ?? []).map((m) => ({
            id: m.id,
            name: m.name,
            kind: m.kind,
          }))}
          refTargets={refTargets ?? []}
          commands={commands}
          placeholder={`Message #${thread.channel.name}`}
          onTyping={announceTyping}
          onSend={async (body) => {
            try {
              await send({
                parentType: "channel",
                parentId: channelId,
                body,
                mentionClerkIds: mentionIdsFrom(body),
              });
            } catch (e) {
              toast(errorMessage(e, "Couldn't send that"), { kind: "error" });
            }
          }}
        />
      </div>
    </section>
  );
}

/** The actor ids mentioned in a body, so the server creates mention rows. */
function mentionIdsFrom(body: string): string[] {
  const ids = new Set<string>();
  for (const m of body.matchAll(/@\[[^\]\n]+\]\(([^)\s]+)\)/g)) {
    ids.add(m[1]);
  }
  return [...ids];
}
