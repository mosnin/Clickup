"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useQuery, useAction, useMutation } from "convex/react";
import { useUser } from "@clerk/nextjs";
import { Sparkles } from "lucide-react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/dashboard/toast";

export default function DashboardHome() {
  const tree = useQuery(api.sidebar.tree, {});
  const quickTask = useAction(api.ai.quickTask);
  const removeTask = useMutation(api.tasks.remove);
  const { user } = useUser();
  const { showUndo } = useToast();
  const router = useRouter();

  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed || pending || !user) return;
    setPending(true);
    setError(null);
    try {
      const result = await quickTask({
        prompt: trimmed,
        scopeType: "user",
        scopeId: user.id,
      });
      if (result.ok) {
        setQuery("");
        router.push(`/dashboard/l/${result.listId}/t/${result.taskId}`);
        showUndo({
          label: result.explanation
            ? `Added "${result.title}" — ${result.explanation}`
            : `Added "${result.title}"`,
          onUndo: () => removeTask({ taskId: result.taskId }),
        });
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setPending(false);
    }
  }

  if (tree === undefined) {
    return <DashboardSkeleton />;
  }
  if (tree === null) {
    return null;
  }

  return (
    <div>
      <section className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          What needs doing?
        </h1>
        <form
          onSubmit={handleSubmit}
          className="flex items-center gap-2 rounded-full border border-border bg-background px-4 py-2 shadow-sm focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500/20"
        >
          <Sparkles className="h-4 w-4 text-brand-600" aria-hidden />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="Try: remind me to call mom Friday at 3"
            disabled={pending}
            className="flex-1 bg-transparent text-sm focus:outline-none disabled:opacity-50 sm:text-base"
          />
          <Button type="submit" size="sm" disabled={!query.trim() || pending}>
            {pending ? "Creating…" : "Add"}
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">
          Or press{" "}
          <kbd className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px]">
            ⌘K
          </kbd>{" "}
          from anywhere.
        </p>
        {error && (
          <p className="text-xs text-red-600" role="alert">
            {error}
          </p>
        )}
      </section>

      <div className="mt-12 space-y-8">
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Your spaces
          </h2>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {tree.personal ? (
              <li>
                <Link
                  href="/dashboard/personal"
                  className="block rounded-3xl border border-border bg-background p-4 transition-colors hover:border-brand-500"
                >
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="inline-block h-3 w-3 rounded-full"
                      style={{ backgroundColor: tree.personal.color ?? "#6366f1" }}
                    />
                    <span className="font-medium">{tree.personal.name}</span>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {tree.personal.lists.length +
                      tree.personal.folders.reduce(
                        (n, f) => n + f.lists.length,
                        0,
                      )}{" "}
                    lists · {tree.personal.folders.length} folders
                  </p>
                </Link>
              </li>
            ) : (
              <li className="rounded-3xl border border-dashed border-border bg-muted/30 p-4 text-sm text-muted-foreground">
                Setting up your personal space…
              </li>
            )}
          </ul>
        </section>

        <section>
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Team workspaces
            </h2>
            <Link
              href="/onboarding"
              className="text-sm font-medium text-brand-600 hover:underline"
            >
              New workspace →
            </Link>
          </div>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {tree.workspaces.length === 0 && (
              <li className="rounded-3xl border border-dashed border-border bg-muted/30 p-4 text-sm text-muted-foreground sm:col-span-2">
                No team yet.{" "}
                <Link
                  href="/onboarding"
                  className="font-medium text-brand-600 hover:underline"
                >
                  Create a workspace
                </Link>{" "}
                and invite a teammate.
              </li>
            )}
            {tree.workspaces.map((ws) => (
              <li key={ws._id}>
                <Link
                  href={`/dashboard/w/${ws._id}`}
                  className="block rounded-3xl border border-border bg-background p-4 transition-colors hover:border-brand-500"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{ws.name}</span>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                      {ws.role}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {ws.spaces.length} space{ws.spaces.length === 1 ? "" : "s"}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-8 w-1/3 animate-pulse rounded-full bg-muted" />
      <div className="h-12 animate-pulse rounded-full bg-muted/60" />
      <div className="grid gap-3 sm:grid-cols-2">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="h-24 animate-pulse rounded-3xl border border-border bg-muted/40"
          />
        ))}
      </div>
    </div>
  );
}
