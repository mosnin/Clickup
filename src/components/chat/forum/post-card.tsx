"use client";

// One post, as a card in a list.
//
// This is the whole difference §5.1 draws between a post and a chat message,
// drawn: a message is a line whose author and time are chrome around what was
// said, and a card is a **title** with a person's name under it and a paragraph
// of the body beneath that. A reader scanning a forum is deciding what to open,
// not reading a conversation — so the title is the largest thing on the card and
// the body is 200 characters of evidence for whether the title is worth it.
//
// The whole card is a link, not a card with a link in it. A row whose only
// target is a small "open" affordance is a row people click three times before
// finding the one pixel that works.
//
// No decorative icons: the reply count is a sentence, the author is a name, and
// the only glyph on the card would have been an ornament beside a heading.

import Link from "next/link";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";
import type { TimelineActor } from "@/lib/buzz/timeline";
import { truncatePubkey } from "@/lib/buzz/timeline";
import { forumPostHref, replyCountLabel, type ForumCard } from "./model";

export function PostCard({
  card,
  channelId,
  actors,
}: {
  card: ForumCard;
  channelId: string;
  /** pubkey → resolved principal. Missing is fine; a truncated key is honest. */
  actors: ReadonlyMap<string, TimelineActor>;
}) {
  const { message, summary } = card;
  const label = (pubkey: string): string =>
    actors.get(pubkey)?.label?.trim() || truncatePubkey(pubkey);

  return (
    <article
      data-forum-post={message.id}
      className={cn(
        "bento relative rounded-2xl px-4 py-3.5 transition-colors",
        "hover:bg-[var(--chat-hover)]",
        message.pending && "opacity-60",
      )}
    >
      <h3 className="text-compact font-semibold leading-snug">
        <Link
          href={forumPostHref(channelId, message.id)}
          // Stretched over the card: the heading is the accessible name of the
          // link, and the invisible overlay is what makes the rest of the card
          // clickable without nesting interactive elements inside one another.
          className="after:absolute after:inset-0 after:content-[''] focus-visible:underline"
        >
          {/* A post with no title is a post written before titles existed, or by
              something that skipped the tag. It still has to be openable. */}
          {card.title || "Untitled post"}
        </Link>
      </h3>

      <p className="chat-quiet mt-1 flex flex-wrap items-center gap-x-2 text-xs">
        <span className="font-medium">{label(message.pubkey)}</span>
        {message.isAgent ? (
          <span className="rounded-full bg-[var(--chat-hover)] px-1.5 text-micro font-medium uppercase tracking-wide">
            agent
          </span>
        ) : null}
        <time dateTime={new Date(message.createdAt * 1000).toISOString()}>
          {timeAgo(message.createdAt * 1000)}
        </time>
        {message.edited ? <span>edited</span> : null}
      </p>

      {card.preview ? (
        <p className="chat-quiet mt-2 text-sm leading-relaxed">{card.preview}</p>
      ) : null}

      {summary ? (
        <p className="chat-quiet mt-2.5 flex flex-wrap items-center gap-x-2 text-xs">
          <span className="font-medium">{replyCountLabel(summary)}</span>
          {summary.lastReplyAt > 0 ? (
            <span>· last {timeAgo(summary.lastReplyAt * 1000)}</span>
          ) : null}
          {summary.participants.length > 0 ? (
            <span className="min-w-0 truncate">
              · {summary.participants.map(label).join(", ")}
            </span>
          ) : null}
        </p>
      ) : null}
    </article>
  );
}
