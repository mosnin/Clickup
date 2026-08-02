"use client";

// The canvas, docked beside the room.
//
// A canvas is one markdown document, and this product already has a
// markdown-backed rich editor — `components/dashboard/page-editor`. So this
// pane **is** that editor, configured differently, rather than a second one.
// The reasons are the ones the Pages section of CLAUDE.md gives and they apply
// here word for word: markdown is the storage, Tiptap is the surface, and every
// construct the editor can produce has a markdown spelling that survives a save.
// A second editor over the same bytes would be a second answer to "what can a
// block be", and the day the two disagree is the day one of them starts
// deleting the other's tables.
//
// Two things this pane does *not* reuse, and why:
//
//   - **Page links (`[[…]]`) resolve to nothing.** A canvas belongs to a room,
//     not to a Pages tree, so the title index is empty and an unresolved link
//     renders `.page-wikilink-missing` — which reads as "a page that does not
//     exist yet", which is exactly true.
//   - **Read mode is the same editor with `editable={false}`**, not a separate
//     markdown renderer. Both the drag handle and the selection toolbar already
//     gate on `isEditable`, so the affordances disappear on their own — and a
//     reader and a writer looking at the same document see the same document,
//     which a second renderer could not promise for long.
//
// ## Last-write-wins is visible here or it is nowhere
//
// The backend keeps Buzz's clobbering (see `convex/buzz/canvas.ts` for why: the
// log is append-only, so nothing is destroyed, and refusing would lock agents
// out of a surface they are supposed to share). The cost of that decision is
// paid on this screen, in three places:
//
//   1. **While you edit**, the head is a live subscription. If it moves, a note
//      appears immediately — before you save, when you can still do something
//      cheap about it.
//   2. **When you save over something you had not read**, the write reports it
//      and a banner names whose edit you replaced.
//   3. **Their version is one click away.** Restoring is an ordinary save of
//      the old content, so it is itself undoable.

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { timeAgo } from "@/lib/time";
import type { ChatScope } from "@/lib/buzz/channel-types";
import { PageBodyEditor } from "@/components/dashboard/page-editor";

type CanvasAuthor = { pubkey: string; name: string; isAgent: boolean };

type CanvasHead = {
  content: string | null;
  eventId: string | null;
  updatedAt: number | null;
  author: CanvasAuthor | null;
  canEdit: boolean;
};

type CanvasWrite = {
  status: "written" | "unchanged";
  eventId: string;
  replaced: { eventId: string; updatedAt: number; author: CanvasAuthor | null } | null;
  unseen: boolean;
};

type ScopedChannel = { scopeType: string; scopeId: string; channelId: string };

/**
 * Named by hand for the reason `room-composer.tsx` states: the checked-in
 * `_generated/api.d.ts` predates `convex/buzz/`, so `api.buzz.canvas.*` does
 * not typecheck until somebody runs `npx convex dev`. The runtime path is the
 * same. **Replace these with `api.buzz.canvas.*` once the CLI regenerates.**
 */
const readRef = makeFunctionReference<"query", ScopedChannel, CanvasHead | null>(
  "buzz/canvas:read",
);
const readVersionRef = makeFunctionReference<
  "query",
  ScopedChannel & { eventId: string },
  { content: string } | null
>("buzz/canvas:readVersion");
const writeRef = makeFunctionReference<
  "mutation",
  ScopedChannel & { content: string; basedOn?: string },
  CanvasWrite
>("buzz/canvas:write");

/** What a save landed on, kept until the person has dealt with it. */
type Clobber = {
  eventId: string;
  authorName: string;
  updatedAt: number;
};

export function CanvasPane({
  scope,
  channelId,
}: {
  scope: ChatScope | null;
  channelId: string;
}) {
  const { toast } = useToast();
  const args = scope ? { ...scope, channelId } : "skip";
  const head = useQuery(readRef, args);
  const write = useMutation(writeRef);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [clobber, setClobber] = useState<Clobber | null>(null);
  /** The revision this edit started from. What `basedOn` sends. */
  const baseRef = useRef<string | null>(null);

  const content = head?.content ?? null;
  const canEdit = head?.canEdit ?? false;

  // Somebody else changed it while this pane was in read mode: adopt it
  // silently. There is nothing to lose and nothing to decide.
  useEffect(() => {
    if (!editing) setDraft(content ?? "");
  }, [content, editing]);

  const startEditing = useCallback(() => {
    baseRef.current = head?.eventId ?? null;
    setDraft(content ?? "");
    setClobber(null);
    setEditing(true);
  }, [content, head?.eventId]);

  const cancel = useCallback(() => {
    setEditing(false);
    setDraft(content ?? "");
  }, [content]);

  const save = useCallback(async () => {
    if (!scope) return;
    setSaving(true);
    try {
      const result = await write({
        ...scope,
        channelId,
        content: draft,
        ...(baseRef.current ? { basedOn: baseRef.current } : {}),
      });
      setEditing(false);
      if (!result) return;
      if (result.status === "unchanged") {
        toast("Nothing changed, so nothing was saved.");
        return;
      }
      if (result.unseen && result.replaced) {
        // The whole point of keeping last-write-wins: the write landed, and
        // the person is told what it landed on rather than finding out later
        // from somebody who lost an edit.
        setClobber({
          eventId: result.replaced.eventId,
          authorName: result.replaced.author?.name ?? "Someone",
          updatedAt: result.replaced.updatedAt,
        });
        return;
      }
      toast("Canvas saved");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not save the canvas", {
        kind: "error",
      });
    } finally {
      setSaving(false);
    }
  }, [channelId, draft, scope, toast, write]);

  if (head === undefined) {
    return <div className="chat-quiet py-6 text-sm">Loading…</div>;
  }

  return (
    <div className="flex min-h-0 flex-col gap-3 pb-2">
      {clobber ? (
        <ClobberBanner
          scope={scope}
          channelId={channelId}
          clobber={clobber}
          onDismiss={() => setClobber(null)}
        />
      ) : null}

      {editing ? (
        <MovedUnderYou
          headEventId={head?.eventId ?? null}
          baseEventId={baseRef.current}
          authorName={head?.author?.name ?? "Someone"}
          onTakeTheirs={() => {
            baseRef.current = head?.eventId ?? null;
            setDraft(content ?? "");
          }}
        />
      ) : null}

      <div className="flex items-center gap-2">
        <p className="chat-quiet min-w-0 flex-1 truncate text-xs">
          {head?.updatedAt && head?.author
            ? `Edited by ${head.author.name} ${timeAgo(head.updatedAt)}`
            : "No canvas set for this channel."}
        </p>
        {canEdit && !editing ? (
          <Button size="sm" variant="secondary" onClick={startEditing}>
            {content === null ? "Create canvas" : "Edit"}
          </Button>
        ) : null}
        {editing ? (
          <>
            <Button size="sm" variant="ghost" onClick={cancel} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </>
        ) : null}
      </div>

      {/* The same editor in both modes. `key` forces a fresh instance when the
          mode flips, so an editable surface never inherits a read-only one's
          selection state — and when the room changes, so the previous room's
          document cannot flash in the new one. */}
      <PageBodyEditor
        key={`${channelId}:${editing ? "edit" : "read"}`}
        markdown={editing ? draft : (content ?? "")}
        editable={editing}
        mentionables={[]}
        pageTitles={[]}
        onChange={setDraft}
      />
    </div>
  );
}

/**
 * "Ada changed this while you were editing."
 *
 * Shown *during* the edit, not after the save, because that is when it is
 * cheap: the choice is still "keep typing" or "take theirs and re-apply my
 * change", and neither has cost anybody an edit yet. Taking theirs replaces the
 * draft, which is the only destructive thing on this screen — and it is
 * destroying an unsaved draft the person is looking at, on their own click.
 */
function MovedUnderYou({
  headEventId,
  baseEventId,
  authorName,
  onTakeTheirs,
}: {
  headEventId: string | null;
  baseEventId: string | null;
  authorName: string;
  onTakeTheirs: () => void;
}) {
  if (!headEventId || headEventId === baseEventId) return null;
  return (
    <div role="status" className="bento-tile rounded-xl p-3 text-xs">
      <p>
        {authorName} changed this canvas while you were editing. Saving will
        replace their version — it stays in the history either way.
      </p>
      <Button
        size="sm"
        variant="ghost"
        className="mt-2"
        onClick={onTakeTheirs}
      >
        Take theirs
      </Button>
    </div>
  );
}

/**
 * "You replaced Bob's edit."
 *
 * The banner exists because the alternative is silence, and silence is what
 * makes last-write-wins feel like data loss even when it is not. Restoring is
 * an ordinary save, so this offer costs nothing and is itself reversible.
 */
function ClobberBanner({
  scope,
  channelId,
  clobber,
  onDismiss,
}: {
  scope: ChatScope | null;
  channelId: string;
  clobber: Clobber;
  onDismiss: () => void;
}) {
  const { toast } = useToast();
  const write = useMutation(writeRef);
  const theirs = useQuery(
    readVersionRef,
    scope ? { ...scope, channelId, eventId: clobber.eventId } : "skip",
  );

  return (
    <div role="status" className="bento-tile rounded-xl p-3 text-xs">
      <p>
        Your version replaced {clobber.authorName}&apos;s edit from{" "}
        {timeAgo(clobber.updatedAt)}. Nothing was lost — theirs is still in the
        history.
      </p>
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={!theirs || !scope}
          onClick={async () => {
            if (!theirs || !scope) return;
            try {
              await write({ ...scope, channelId, content: theirs.content });
              toast(`Restored ${clobber.authorName}'s version`);
              onDismiss();
            } catch (error) {
              toast(
                error instanceof Error ? error.message : "Could not restore",
                { kind: "error" },
              );
            }
          }}
        >
          Restore theirs
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Keep mine
        </Button>
      </div>
    </div>
  );
}
