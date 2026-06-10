"use client";

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { Sparkles, X } from "lucide-react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";

const STORAGE_KEY = "pace.first-run.dismissed";

// First-run welcome dialog. Shows once per user-per-device after the
// onboarding wizard completes. Persisted dismissal in localStorage so
// it doesn't follow the user back. The visible content is the same on
// any return — there's nothing here you can't repeat without harm.
export function FirstRunDialog() {
  const me = useQuery(api.users.current, {});
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!me?.onboardedAt) return;
    if (window.localStorage.getItem(STORAGE_KEY) === "1") return;
    // Tiny delay so it doesn't fight the dashboard's first paint.
    const id = setTimeout(() => setOpen(true), 250);
    return () => clearTimeout(id);
  }, [me?.onboardedAt]);

  function dismiss() {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, "1");
    }
    setOpen(false);
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Pace"
      className="fixed inset-0 z-[55] flex items-end justify-center px-4 pb-6 sm:items-center sm:pb-0"
    >
      <div
        aria-hidden
        onClick={dismiss}
        className="absolute inset-0 bg-foreground/40 backdrop-blur-sm"
      />
      <div className="relative w-full max-w-md overflow-hidden rounded-3xl border border-border bg-background shadow-2xl">
        <div className="flex items-start justify-between border-b border-border px-5 py-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-brand-600" aria-hidden />
            <h2 className="text-sm font-semibold">Welcome to Pace</h2>
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={dismiss}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 px-5 py-4 text-sm">
          <Hint kbd="⌘K">
            Search for any task, list, doc, or person — and run commands.
          </Hint>
          <Hint kbd="?">See every keyboard shortcut.</Hint>
          <Hint kbd="↗">Click a task to open it. Edit on the way through.</Hint>
          <Hint kbd="↺">
            Anything you delete sits in <strong>Trash</strong> for 30 days.
          </Hint>
        </div>
        <div className="flex justify-end border-t border-border bg-muted/40 px-5 py-3">
          <Button size="sm" onClick={dismiss}>
            Got it
          </Button>
        </div>
      </div>
    </div>
  );
}

function Hint({ kbd, children }: { kbd: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <kbd className="min-w-9 rounded border border-border bg-muted px-1.5 py-0.5 text-center font-mono text-[11px]">
        {kbd}
      </kbd>
      <p className="text-muted-foreground">{children}</p>
    </div>
  );
}
