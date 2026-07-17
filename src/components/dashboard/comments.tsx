"use client";

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { CheckCircle2, X } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Picker } from "@/components/ui/picker";
import { Monogram } from "@/components/dashboard/monogram";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";
import { useToast } from "@/components/toast";
import { EASE, motion } from "@/components/motion";
import {
  extractMentionedClerkIds,
  formatMentionToken,
  parseMentionBody,
  type MessagePart,
} from "@/lib/mentions";

type ParentType = "task" | "space" | "workspace" | "channel";

// Shape returned by messages.listMentionableUsers: workspace members plus
// AI agents (agents carry their id in clerkId and isAgent: true).
type Member = {
  clerkId: string;
  name?: string;
  email: string;
  imageUrl?: string;
  isAgent?: boolean;
};

export function Comments({
  parentType,
  parentId,
  emptyHint,
}: {
  parentType: ParentType;
  parentId: string;
  emptyHint?: string;
}) {
  const messages = useQuery(api.messages.listForParent, {
    parentType,
    parentId,
  });
  const members = useQuery(api.messages.listMentionableUsers, {
    parentType,
    parentId,
  });

  if (messages === undefined || members === undefined) {
    return (
      <div className="space-y-3">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="h-16 animate-pulse rounded-2xl bg-muted/40"
          />
        ))}
      </div>
    );
  }

  const topLevel = messages.filter((m) => !m.parentMessageId);
  const repliesByParent = new Map<Id<"messages">, Doc<"messages">[]>();
  for (const m of messages) {
    if (m.parentMessageId) {
      const arr = repliesByParent.get(m.parentMessageId) ?? [];
      arr.push(m);
      repliesByParent.set(m.parentMessageId, arr);
    }
  }
  for (const arr of repliesByParent.values())
    arr.sort((a, b) => a.createdAt - b.createdAt);

  const memberByClerkId = new Map(members.map((u) => [u.clerkId, u]));

  return (
    <div className="space-y-4">
      {topLevel.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {emptyHint ?? "No comments yet."}
        </p>
      )}
      <ul className="space-y-3">
        {topLevel.map((m) => (
          <motion.li
            key={m._id}
            layout
            initial={{ opacity: 0, y: 10, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.4, ease: EASE }}
          >
            <MessageItem
              message={m}
              replies={repliesByParent.get(m._id) ?? []}
              memberByClerkId={memberByClerkId}
              members={members}
              parentType={parentType}
              parentId={parentId}
            />
          </motion.li>
        ))}
      </ul>

      <Composer
        parentType={parentType}
        parentId={parentId}
        members={members}
        placeholder={
          parentType === "task"
            ? "Add a comment…"
            : parentType === "workspace"
              ? "Send a message to your team…"
              : "Add a message…"
        }
      />
    </div>
  );
}

function MessageItem({
  message,
  replies,
  memberByClerkId,
  members,
  parentType,
  parentId,
}: {
  message: Doc<"messages">;
  replies: Doc<"messages">[];
  memberByClerkId: Map<string, Member>;
  members: Member[];
  parentType: ParentType;
  parentId: string;
}) {
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const remove = useMutation(api.messages.remove);
  const resolve = useMutation(api.messages.resolve);
  const { toast } = useToast();

  const author = memberByClerkId.get(message.authorClerkId);
  const assignee = message.assigneeClerkId
    ? memberByClerkId.get(message.assigneeClerkId)
    : null;
  const isResolved = !!message.resolvedAt;

  // Hidden while its undo toast is live — the actual delete only commits
  // once the toast expires.
  if (deleting) return null;

  return (
    <div
      className={cn(
        "rounded-2xl bento p-3",
        isResolved && "opacity-60",
      )}
    >
      <div className="flex items-start gap-3">
        <Avatar user={author} clerkId={message.authorClerkId} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-sm font-medium">
              {author?.name ?? "Someone"}
            </span>
            <span className="text-xs text-muted-foreground">
              {timeAgo(message.createdAt)}
              {message.editedAt && " · edited"}
            </span>
            {assignee && (
              <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[10px] uppercase tracking-wider text-brand-700">
                Assigned to {assignee.name ?? "user"}
              </span>
            )}
            <span className="ml-auto flex items-center gap-1">
              {message.assigneeClerkId && (
                <button
                  type="button"
                  onClick={() =>
                    resolve({
                      messageId: message._id,
                      resolved: !isResolved,
                    })
                  }
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                  title={isResolved ? "Reopen" : "Mark resolved"}
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {isResolved ? "Reopen" : "Resolve"}
                </button>
              )}
            </span>
          </div>

          {editing ? (
            <Composer
              parentType={parentType}
              parentId={parentId}
              members={members}
              initialBody={message.body}
              editingMessageId={message._id}
              onDone={() => setEditing(false)}
            />
          ) : (
            <MessageBody
              body={message.body}
              memberByClerkId={memberByClerkId}
            />
          )}

          {!editing && !replying && (
            <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
              <button
                type="button"
                className="hover:text-foreground"
                onClick={() => setReplying(true)}
              >
                Reply
              </button>
              <button
                type="button"
                className="hover:text-foreground"
                onClick={() => setEditing(true)}
              >
                Edit
              </button>
              <button
                type="button"
                className="hover:text-foreground"
                onClick={() => {
                  setDeleting(true);
                  toast("Message deleted", {
                    action: { label: "Undo", onClick: () => setDeleting(false) },
                    onExpire: () => remove({ messageId: message._id }),
                  });
                }}
              >
                Delete
              </button>
            </div>
          )}

          {replies.length > 0 && (
            <ul className="mt-3 space-y-2 border-l-2 border-border pl-3">
              {replies.map((r) => (
                <li key={r._id}>
                  <ReplyItem
                    reply={r}
                    memberByClerkId={memberByClerkId}
                    members={members}
                    parentType={parentType}
                    parentId={parentId}
                  />
                </li>
              ))}
            </ul>
          )}

          {replying && (
            <div className="mt-3 border-l-2 border-border pl-3">
              <Composer
                parentType={parentType}
                parentId={parentId}
                members={members}
                parentMessageId={message._id}
                placeholder="Write a reply…"
                onDone={() => setReplying(false)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ReplyItem({
  reply,
  memberByClerkId,
  members,
  parentType,
  parentId,
}: {
  reply: Doc<"messages">;
  memberByClerkId: Map<string, Member>;
  members: Member[];
  parentType: ParentType;
  parentId: string;
}) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const remove = useMutation(api.messages.remove);
  const { toast } = useToast();
  const author = memberByClerkId.get(reply.authorClerkId);

  if (deleting) return null;

  return (
    <div className="flex items-start gap-2">
      <Avatar user={author} clerkId={reply.authorClerkId} small />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-sm font-medium">
            {author?.name ?? "Someone"}
          </span>
          <span className="text-xs text-muted-foreground">
            {timeAgo(reply.createdAt)}
            {reply.editedAt && " · edited"}
          </span>
        </div>
        {editing ? (
          <Composer
            parentType={parentType}
            parentId={parentId}
            members={members}
            initialBody={reply.body}
            editingMessageId={reply._id}
            onDone={() => setEditing(false)}
          />
        ) : (
          <>
            <MessageBody
              body={reply.body}
              memberByClerkId={memberByClerkId}
            />
            <div className="mt-1 flex gap-2 text-xs text-muted-foreground">
              <button
                type="button"
                className="hover:text-foreground"
                onClick={() => setEditing(true)}
              >
                Edit
              </button>
              <button
                type="button"
                className="hover:text-foreground"
                onClick={() => {
                  setDeleting(true);
                  toast("Reply deleted", {
                    action: { label: "Undo", onClick: () => setDeleting(false) },
                    onExpire: () => remove({ messageId: reply._id }),
                  });
                }}
              >
                Delete
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MessageBody({
  body,
  memberByClerkId,
}: {
  body: string;
  memberByClerkId: Map<string, Member>;
}) {
  const parts = parseMentionBody(body);
  return (
    <p className="mt-1 whitespace-pre-wrap break-words text-sm">
      {parts.map((part, i) => renderPart(part, i, memberByClerkId))}
    </p>
  );
}

function renderPart(
  part: MessagePart,
  i: number,
  memberByClerkId: Map<string, Member>,
) {
  if (part.kind === "text") return <span key={i}>{part.text}</span>;
  const user = memberByClerkId.get(part.clerkId);
  return (
    <span
      key={i}
      className="mx-0.5 inline-flex items-baseline rounded-full bg-brand-100 px-1.5 text-brand-700"
    >
      @{user?.name ?? part.name}
    </span>
  );
}

function Avatar({
  user,
  clerkId,
  small = false,
}: {
  user: Member | undefined;
  clerkId: string;
  small?: boolean;
}) {
  return (
    <Monogram
      name={user?.name ?? clerkId.slice(-2) ?? "?"}
      size={small ? "sm" : "md"}
    />
  );
}

function Composer({
  parentType,
  parentId,
  members,
  parentMessageId,
  initialBody,
  editingMessageId,
  placeholder,
  onDone,
}: {
  parentType: ParentType;
  parentId: string;
  members: Member[];
  parentMessageId?: Id<"messages">;
  initialBody?: string;
  editingMessageId?: Id<"messages">;
  placeholder?: string;
  onDone?: () => void;
}) {
  const [body, setBody] = useState(initialBody ?? "");
  const [pending, setPending] = useState(false);
  const [assignTo, setAssignTo] = useState<string>("");
  const [popover, setPopover] = useState<{ from: number; query: string } | null>(
    null,
  );
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const create = useMutation(api.messages.create);
  const update = useMutation(api.messages.update);

  const filtered = useMemo(() => {
    if (!popover) return [];
    const q = popover.query.toLowerCase();
    return members
      .filter((m) =>
        (m.name ?? m.email).toLowerCase().includes(q.toLowerCase()),
      )
      .slice(0, 6);
  }, [popover, members]);

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setBody(value);
    const caret = e.target.selectionStart ?? value.length;
    // Look back for the closest "@" with no whitespace between caret and "@".
    const upToCaret = value.slice(0, caret);
    const at = upToCaret.lastIndexOf("@");
    if (at < 0) {
      setPopover(null);
      return;
    }
    const between = upToCaret.slice(at + 1);
    if (/\s/.test(between)) {
      setPopover(null);
      return;
    }
    // Don't open a popover for a mention that's already been inserted as
    // `@[Name](clerkId)` — those have a `[` immediately after the @.
    if (between.startsWith("[")) {
      setPopover(null);
      return;
    }
    setPopover({ from: at, query: between });
  }

  function insertMention(user: Member) {
    if (!popover) return;
    const before = body.slice(0, popover.from);
    const after = body.slice(popover.from + 1 + popover.query.length);
    const token = formatMentionToken(user.name ?? user.email, user.clerkId);
    const next = `${before}${token} ${after}`;
    setBody(next);
    setPopover(null);
    requestAnimationFrame(() => taRef.current?.focus());
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim() || pending) return;
    setPending(true);
    try {
      const mentionClerkIds = extractMentionedClerkIds(body);
      if (editingMessageId) {
        await update({
          messageId: editingMessageId,
          body: body.trim(),
          mentionClerkIds,
        });
      } else {
        await create({
          parentType,
          parentId,
          body: body.trim(),
          parentMessageId,
          assigneeClerkId: assignTo || undefined,
          mentionClerkIds,
        });
      }
      setBody("");
      setAssignTo("");
      onDone?.();
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="relative mt-2 space-y-2">
      <textarea
        ref={taRef}
        rows={3}
        value={body}
        onChange={onChange}
        onKeyDown={(e) => {
          if (e.key === "Escape" && popover) {
            e.preventDefault();
            setPopover(null);
          }
        }}
        placeholder={placeholder ?? "Write a message…"}
        className="soft-field w-full resize-none p-3 text-sm focus:outline-none"
      />

      {popover && filtered.length > 0 && (
        <ul className="absolute z-20 mt-0 w-64 overflow-hidden rounded-2xl border border-border bg-background shadow-lg">
          {filtered.map((u) => (
            <li key={u.clerkId}>
              <button
                type="button"
                onClick={() => insertMention(u)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
              >
                <Avatar user={u} clerkId={u.clerkId} small />
                <span className="truncate">{u.name ?? u.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        {!editingMessageId && !parentMessageId && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            Assign to:
            <Picker
              dashed
              label={
                assignTo
                  ? (members.find((m) => m.clerkId === assignTo)?.name ??
                    members.find((m) => m.clerkId === assignTo)?.email ??
                    "Someone")
                  : "No one"
              }
              selectedId={assignTo || undefined}
              options={[
                { id: "", label: "No one" },
                ...members.map((m) => ({
                  id: m.clerkId,
                  label: m.name ?? m.email,
                  hint: m.isAgent ? "agent" : undefined,
                })),
              ]}
              onSelect={(id) => setAssignTo(id)}
            />
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {onDone && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onDone}
            >
              <X className="h-3 w-3" /> Cancel
            </Button>
          )}
          <Button type="submit" size="sm" disabled={!body.trim() || pending}>
            {editingMessageId
              ? pending
                ? "Saving…"
                : "Save"
              : pending
                ? "Posting…"
                : "Post"}
          </Button>
        </div>
      </div>
    </form>
  );
}

