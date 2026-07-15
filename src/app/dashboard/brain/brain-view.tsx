"use client";

import Link from "next/link";
import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { Sparkles } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Stagger, StaggerItem } from "@/components/motion";

type Scope = { type: "user"; id: string } | { type: "workspace"; id: string };

type Source = {
  parentType: "doc" | "task";
  parentId: string;
  textPreview: string;
};

const EXAMPLE_PROMPTS = [
  "What's blocking the launch?",
  "Summarize the open work in this space",
  "Who owns the design review?",
  "What did we decide about pricing?",
];

export function Brain() {
  const tree = useQuery(api.sidebar.tree, {});
  const brainSearch = useAction(api.ai.brainSearch);

  const [scopeKey, setScopeKey] = useState<string>("personal");
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState<string | null>(null);

  if (tree === undefined) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-1/3 animate-pulse rounded-full bg-muted" />
        <div className="h-12 w-full animate-pulse rounded-full bg-muted" />
        <div className="h-32 animate-pulse rounded-2xl bg-muted/40" />
      </div>
    );
  }
  if (tree === null) return null;

  const scopeOptions: { key: string; label: string; scope: Scope }[] = [
    {
      key: "personal",
      label: "Personal",
      scope: { type: "user", id: tree.currentClerkId },
    },
    ...tree.workspaces.map((w) => ({
      key: `ws:${w._id}`,
      label: w.name,
      scope: { type: "workspace" as const, id: w._id as string },
    })),
  ];
  const activeScope =
    scopeOptions.find((s) => s.key === scopeKey)?.scope ??
    scopeOptions[0]?.scope;

  async function run(q: string) {
    if (!q.trim() || pending || !activeScope) return;
    setQuery(q);
    setPending(true);
    setError(null);
    setAnswer(null);
    setSources([]);
    try {
      const res = await brainSearch({
        scopeType: activeScope.type,
        scopeId: activeScope.id,
        query: q.trim(),
      });
      setAnswer(res.answer);
      setSources(res.sources);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to search");
    } finally {
      setPending(false);
    }
  }

  const idle = !pending && !answer && !error && sources.length === 0;

  return (
    <div className="space-y-6">
      <header className="title-rule">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          Brain
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Ask a question about your tasks and docs. Answers cite sources.
        </p>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(query);
        }}
        className="space-y-3"
      >
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-muted-foreground">
            Search in:
            <select
              value={scopeKey}
              onChange={(e) => setScopeKey(e.currentTarget.value)}
              className="ml-2 rounded-full border border-border bg-background px-3 py-1 text-xs"
            >
              {scopeOptions.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="What's blocking the launch? Who owns the design review?"
            className="flex-1 rounded-full border border-border bg-background px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <Button type="submit" disabled={!query.trim() || pending}>
            <Sparkles className="h-4 w-4" />
            {pending ? "Thinking…" : "Ask"}
          </Button>
        </div>
      </form>

      {/* Empty state: guided example prompts, so the page is never a blank
          search box staring back at you. */}
      {idle && (
        <section className="rounded-2xl border border-dashed border-border bg-muted/20 p-6">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Try asking
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {EXAMPLE_PROMPTS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => run(p)}
                className="rounded-full border border-border bg-background px-3.5 py-1.5 text-sm text-foreground/80 transition-colors hover:border-foreground/25 hover:text-foreground"
              >
                {p}
              </button>
            ))}
          </div>
        </section>
      )}

      {pending && (
        <div className="space-y-2 rounded-2xl border border-border bg-background p-5">
          <div className="h-3 w-4/5 animate-pulse rounded-full bg-muted" />
          <div className="h-3 w-full animate-pulse rounded-full bg-muted" />
          <div className="h-3 w-2/3 animate-pulse rounded-full bg-muted" />
        </div>
      )}

      {error && (
        <div className="rounded-2xl border border-red-300/40 bg-red-50/40 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {answer && (
        <article className="rounded-2xl border border-border bg-background p-5">
          <p className="whitespace-pre-wrap text-sm leading-relaxed">
            {answer}
          </p>
        </article>
      )}

      {sources.length > 0 && (
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Sources
          </h2>
          <Stagger className="mt-2 space-y-2">
            {sources.map((s, i) => (
              <StaggerItem key={`${s.parentType}:${s.parentId}`}>
                <SourceLink index={i + 1} source={s} />
              </StaggerItem>
            ))}
          </Stagger>
        </section>
      )}
    </div>
  );
}

function SourceLink({ index, source }: { index: number; source: Source }) {
  // Docs link straight to the editor; tasks resolve their listId first.
  const taskListId = useQuery(
    api.tasks.resolveListId,
    source.parentType === "task"
      ? { taskId: source.parentId as Id<"tasks"> }
      : "skip",
  );
  const href =
    source.parentType === "doc"
      ? `/dashboard/d/${source.parentId}`
      : taskListId
        ? `/dashboard/l/${taskListId}/t/${source.parentId}`
        : null;

  const inner = (
    <div className="lift flex items-start gap-3 rounded-2xl border border-border bg-background p-3 hover:border-foreground/25">
      <span className="mt-0.5 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-medium text-brand-700">
        {index}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {source.parentType}
        </p>
        <p className="mt-0.5 truncate text-sm">{source.textPreview}</p>
      </div>
    </div>
  );

  return href ? <Link href={href}>{inner}</Link> : inner;
}

