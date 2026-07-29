"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { ChevronRight, FileText, Plus, Trash2, X } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/dashboard/page-header";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Monogram } from "@/components/dashboard/monogram";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";
import { timeAgo } from "@/lib/time";
import { PageBodyEditor } from "@/components/dashboard/page-editor";
import { Comments } from "@/components/dashboard/comments";
import { cn } from "@/lib/utils";

// The page editor.
//
// A rich editing surface over a markdown document. Tiptap handles the
// typing — slash commands, mentions, tables, formatting — and what gets
// stored is still markdown, so an agent writing `## Heading` and a person
// pressing the H2 button are editing the same bytes. That is the whole
// design: no rich-text model underneath doing a lossy conversion, and
// therefore no way for one side's edit to destroy the other's.
//
// Saving is debounced and quiet — no save button, matching every other
// blur-persisted field in the app.

const SAVE_DEBOUNCE_MS = 700;

export function PageEditor({ pageId }: { pageId: string }) {
  const id = pageId as Id<"pages">;
  const data = useQuery(api.pages.get, { pageId: id });
  const update = useMutation(api.pages.update);
  const remove = useMutation(api.pages.remove);
  const detach = useMutation(api.pages.detach);
  const createPage = useMutation(api.pages.create);
  const getUploadUrl = useMutation(api.pages.generateUploadUrl);
  const urlForUpload = useMutation(api.pages.urlForUpload);
  const router = useRouter();
  const { toast } = useToast();
  const { user } = useUser();

  // "Markdown" is not a fallback — it is the stored format, and being
  // able to see it is how you verify what an agent will read.
  const [mode, setMode] = useState<"rich" | "markdown">("rich");
  const [draft, setDraft] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  // Who wrote the version this draft is based on. A save carries it, and
  // the server refuses if the page has moved on since — the alternative is
  // silently overwriting someone else's paragraph.
  const [conflict, setConflict] = useState<string | null>(null);
  const baseUpdatedAt = useRef<number | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const titles = useQuery(
    api.pages.titlesForScope,
    data
      ? { scopeType: data.page.scopeType, scopeId: data.page.scopeId }
      : "skip",
  );

  // Live co-viewers. A heartbeat row refreshed on a timer, read back through
  // an ordinary Convex subscription — so it is pushed, not polled, and a
  // closed tab ages out on its own.
  const myName =
    user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? null;
  const heartbeat = useMutation(api.pages.heartbeat);
  const others = useQuery(api.pages.viewers, { pageId: id }) ?? [];

  useEffect(() => {
    if (!myName) return;
    const beat = () =>
      void heartbeat({ pageId: id, name: myName, editing: dirty }).catch(
        () => {},
      );
    beat();
    const timer = setInterval(beat, 20_000);
    return () => clearInterval(timer);
  }, [heartbeat, id, myName, dirty]);

  const markdown = draft ?? data?.page.markdown ?? "";
  const mentionables = useQuery(
    api.pages.mentionableActors,
    data
      ? { scopeType: data.page.scopeType, scopeId: data.page.scopeId }
      : "skip",
  );

  // Flush any pending edit when the component goes away, so navigating off
  // mid-sentence doesn't drop the last keystrokes.
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  function queueSave(next: { markdown?: string; title?: string }) {
    setDirty(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void update({
        pageId: id,
        ...next,
        // undefined on the very first save of a freshly loaded page, which
        // the server reads as "don't check" — by then we always have one.
        expectedUpdatedAt: baseUpdatedAt.current ?? undefined,
      })
        .then((res) => {
          if (res?.updatedAt) baseUpdatedAt.current = res.updatedAt;
          setDirty(false);
          setConflict(null);
        })
        .catch((e) => {
          const message = errorMessage(e, "Couldn't save the page");
          setDirty(false);
          // A refused save is not a lost one: the text stays in the editor
          // until the reader decides whose version wins.
          setConflict(message);
        });
    }, SAVE_DEBOUNCE_MS);
  }

  // Adopt the server's version number for a page we haven't edited yet, and
  // notice when it moves under us.
  useEffect(() => {
    if (!data) return;
    if (baseUpdatedAt.current === null) {
      baseUpdatedAt.current = data.page.updatedAt;
      return;
    }
    if (data.page.updatedAt === baseUpdatedAt.current) return;
    if (!dirty) {
      // Nothing local to lose — take theirs.
      baseUpdatedAt.current = data.page.updatedAt;
      setDraft(null);
      setConflict(null);
    } else {
      setConflict(
        `${data.page.updatedByName ?? "Someone else"} edited this page while you were writing`,
      );
    }
  }, [data, dirty]);

  /** Discard the local draft and take the stored version. */
  function takeTheirs() {
    if (!data) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    baseUpdatedAt.current = data.page.updatedAt;
    setDraft(null);
    setTitle(null);
    setDirty(false);
    setConflict(null);
  }

  /** Force the local draft over the stored version. */
  function keepMine() {
    if (!data) return;
    baseUpdatedAt.current = data.page.updatedAt;
    setConflict(null);
    queueSave({ markdown, title: title ?? data.page.title });
  }

  async function uploadImage(file: File): Promise<string | null> {
    try {
      const uploadUrl = await getUploadUrl({});
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      const { storageId } = (await res.json()) as { storageId: string };
      return await urlForUpload({ storageId: storageId as Id<"_storage"> });
    } catch (e) {
      toast(errorMessage(e, "Couldn't upload that image"), { kind: "error" });
      return null;
    }
  }

  /** Follow a [[link]] — creating the page first when it doesn't exist. */
  function openPageLink(linkTitle: string, linkedPageId: string | null) {
    if (linkedPageId) {
      router.push(`/dashboard/pages/${linkedPageId}`);
      return;
    }
    if (!data) return;
    void createPage({
      scopeType: data.page.scopeType,
      scopeId: data.page.scopeId,
      title: linkTitle,
    })
      .then((newId) => router.push(`/dashboard/pages/${newId}`))
      .catch((e) =>
        toast(errorMessage(e, "Couldn't create that page"), { kind: "error" }),
      );
  }

  if (data === undefined) return <EditorSkeleton />;
  if (data === null) {
    return (
      <EmptyState
        title="Page not found"
        message="It may have been deleted, or you may not have access to the workspace it lives in."
      />
    );
  }

  const { page, backlinks, attachments, ancestors, children } = data;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={FileText}
        title={title ?? page.title}
        context={
          <span className="flex items-center gap-2">
            <span>
              {dirty
                ? "Saving…"
                : page.updatedByName
                  ? `${page.updatedByName} · ${timeAgo(page.updatedAt)}`
                  : timeAgo(page.updatedAt)}
            </span>
            {others.length > 0 && (
              <span className="flex items-center gap-1">
                {others.slice(0, 3).map((m) => (
                  <span
                    key={m.actorId}
                    title={m.editing ? `${m.name} is editing` : `${m.name} is here`}
                    className={cn(
                      "inline-flex rounded-full ring-2",
                      m.editing ? "ring-brand-500" : "ring-transparent",
                    )}
                  >
                    <Monogram name={m.name} size="sm" />
                  </span>
                ))}
                {others.length > 3 && (
                  <span className="text-[11px]">+{others.length - 3}</span>
                )}
              </span>
            )}
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            <div className="segmented">
              {(["rich", "markdown"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={mode === m}
                  onClick={() => setMode(m)}
                  className={cn(
                    "px-3 py-1.5 text-xs capitalize",
                    mode === m && "segmented-on",
                  )}
                >
                  {m === "rich" ? "Editor" : "Markdown"}
                </button>
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              aria-label="Delete page"
              onClick={() => {
                void remove({ pageId: id })
                  .then(() => {
                    toast("Page deleted");
                    router.push("/dashboard/pages");
                  })
                  .catch((e) =>
                    toast(errorMessage(e, "Couldn't delete the page"), {
                      kind: "error",
                    }),
                  );
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-start">
        <div className="min-w-0 space-y-4">
          {ancestors.length > 0 && (
            <nav
              aria-label="Breadcrumb"
              className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
            >
              {ancestors.map((a) => (
                <span key={a.pageId} className="flex items-center gap-1">
                  <Link
                    href={`/dashboard/pages/${a.pageId}`}
                    className="max-w-[12rem] truncate hover:text-foreground hover:underline"
                  >
                    {a.title}
                  </Link>
                  <ChevronRight className="h-3 w-3 flex-shrink-0" />
                </span>
              ))}
            </nav>
          )}

          {conflict && (
            <div
              role="alert"
              className="bento-tile flex flex-wrap items-center gap-3 rounded-xl px-4 py-3 text-sm"
            >
              <span className="min-w-0 flex-1">{conflict}</span>
              <Button variant="outline" size="sm" onClick={takeTheirs}>
                Take theirs
              </Button>
              <Button size="sm" onClick={keepMine}>
                Keep mine
              </Button>
            </div>
          )}

          {/* The title is the page's identity, so it reads like one: big,
              borderless, and ghosted until it has a name. */}
          <input
            value={title ?? page.title}
            aria-label="Page title"
            placeholder="Untitled"
            onChange={(e) => {
              setTitle(e.currentTarget.value);
              queueSave({ title: e.currentTarget.value });
            }}
            className="w-full bg-transparent text-4xl font-bold tracking-tight placeholder:text-muted-foreground/35 focus:outline-none"
          />

          {mode === "markdown" ? (
            <textarea
              value={markdown}
              aria-label="Page markdown"
              spellCheck={false}
              onChange={(e) => {
                setDraft(e.currentTarget.value);
                queueSave({ markdown: e.currentTarget.value });
              }}
              placeholder={"# A heading\n- a point\n[[Link to another page]]"}
              className="soft-field min-h-[28rem] w-full resize-y px-4 py-3 font-mono text-[13px] leading-relaxed"
            />
          ) : (
            <PageBodyEditor
              markdown={markdown}
              mentionables={mentionables ?? []}
              pageTitles={titles ?? []}
              onOpenPageLink={openPageLink}
              uploadImage={uploadImage}
              onChange={(next) => {
                setDraft(next);
                queueSave({ markdown: next });
              }}
            />
          )}
        </div>

        <div className="space-y-4">
          <Card className="rounded-2xl p-5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Inside this page
              </span>
              <button
                type="button"
                aria-label="New subpage"
                onClick={() => {
                  void createPage({
                    scopeType: page.scopeType,
                    scopeId: page.scopeId,
                    title: "Untitled",
                    parentPageId: id,
                  })
                    .then((newId) => router.push(`/dashboard/pages/${newId}`))
                    .catch((e) =>
                      toast(errorMessage(e, "Couldn't create the subpage"), {
                        kind: "error",
                      }),
                    );
                }}
                className="tap-target inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            {children.length === 0 ? (
              <p className="mt-3 text-xs text-muted-foreground">
                Long pages get unreadable. Break a section out into a subpage
                and it stays linked from here.
              </p>
            ) : (
              <ul className="mt-3 space-y-1.5">
                {children.map((c) => (
                  <li key={c.pageId}>
                    <Link
                      href={`/dashboard/pages/${c.pageId}`}
                      className="block truncate text-sm hover:underline"
                    >
                      {c.title}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="rounded-2xl p-5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Pinned to
              </span>
              <AttachPageButton pageId={id} scopeId={page.scopeId} />
            </div>
            {attachments.length === 0 ? (
              <p className="mt-3 text-xs text-muted-foreground">
                Pin this page to a project, list or task so it shows up where
                the work is — and travels to agents with it.
              </p>
            ) : (
              <ul className="mt-3 space-y-1.5">
                {attachments.map((a) => (
                  <li
                    key={a.attachmentId}
                    className="group flex items-center gap-2 text-sm"
                  >
                    {a.href ? (
                      <Link
                        href={a.href}
                        className="min-w-0 flex-1 truncate hover:underline"
                      >
                        {a.label}
                      </Link>
                    ) : (
                      <span className="min-w-0 flex-1 truncate">{a.label}</span>
                    )}
                    <span className="flex-shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                      {a.targetType}
                    </span>
                    <button
                      type="button"
                      aria-label={`Unpin from ${a.label}`}
                      onClick={() => {
                        void detach({
                          attachmentId:
                            a.attachmentId as Id<"pageAttachments">,
                        }).catch((e) =>
                          toast(errorMessage(e, "Couldn't unpin"), {
                            kind: "error",
                          }),
                        );
                      }}
                      className="tap-target flex-shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* The discussion about the document, deliberately beside it rather
              than inside it: an agent reading the page should get the decision,
              not the argument that produced it. */}
          <Card className="rounded-2xl p-5">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Discussion
            </span>
            <div className="mt-3">
              <Comments parentType="page" parentId={id} />
            </div>
          </Card>

          <Card className="rounded-2xl p-5">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Linked from
            </span>
            {backlinks.length === 0 ? (
              <p className="mt-3 text-xs text-muted-foreground">
                Nothing links here yet. Write{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                  [[{page.title}]]
                </code>{" "}
                in another page to connect them.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {backlinks.map((b) => (
                  <li key={b.pageId}>
                    <Link
                      href={`/dashboard/pages/${b.pageId}`}
                      className="block text-sm hover:underline"
                    >
                      {b.title}
                    </Link>
                    {b.excerpt && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {b.excerpt}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

/** Pin this page to a project or list, chosen from the sidebar tree. */
function AttachPageButton({
  pageId,
  scopeId,
}: {
  pageId: Id<"pages">;
  scopeId: string;
}) {
  const tree = useQuery(api.sidebar.tree, {});
  const attach = useMutation(api.pages.attach);
  const { toast } = useToast();
  const [open, setOpen] = useState(false);

  // Only offer targets inside this page's own scope — the server refuses
  // anything else, and offering it would be a UI that lies.
  const targets = useMemo(() => {
    const out: { type: "project" | "list"; id: string; label: string }[] = [];
    const workspace = tree?.workspaces.find((w) => w._id === scopeId);
    const spaces = workspace
      ? workspace.spaces
      : (tree?.personal ? [tree.personal] : []);
    for (const sp of spaces) {
      for (const p of sp.projects) {
        out.push({ type: "project", id: p._id, label: `${sp.name} · ${p.name}` });
        for (const l of p.lists) {
          out.push({ type: "list", id: l._id, label: `${p.name} · ${l.name}` });
        }
      }
      for (const l of sp.lists) {
        out.push({ type: "list", id: l._id, label: `${sp.name} · ${l.name}` });
      }
    }
    return out;
  }, [tree, scopeId]);

  if (!open) {
    return (
      <button
        type="button"
        aria-label="Pin this page somewhere"
        onClick={() => setOpen(true)}
        className="tap-target inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    );
  }

  return (
    <select
      autoFocus
      aria-label="Choose where to pin this page"
      defaultValue=""
      onBlur={() => setOpen(false)}
      onChange={(e) => {
        const [type, id] = e.currentTarget.value.split(":");
        if (!id) return;
        void attach({
          pageId,
          targetType: type as "project" | "list",
          targetId: id,
        })
          .then(() => {
            toast("Pinned");
            setOpen(false);
          })
          .catch((err) =>
            toast(errorMessage(err, "Couldn't pin the page"), {
              kind: "error",
            }),
          );
      }}
      className="soft-field max-w-[10rem] px-2 py-1 text-xs"
    >
      <option value="" disabled>
        Pin to…
      </option>
      {targets.map((t) => (
        <option key={`${t.type}:${t.id}`} value={`${t.type}:${t.id}`}>
          {t.label}
        </option>
      ))}
    </select>
  );
}

function EditorSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-8 w-64 animate-pulse rounded-lg bg-muted" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="space-y-3">
          <div className="h-10 w-2/3 animate-pulse rounded-lg bg-muted" />
          <div className="h-80 animate-pulse rounded-2xl bg-muted" />
        </div>
        <div className="space-y-4">
          <div className="h-32 animate-pulse rounded-2xl bg-muted" />
          <div className="h-32 animate-pulse rounded-2xl bg-muted" />
        </div>
      </div>
    </div>
  );
}
