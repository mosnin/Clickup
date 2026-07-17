"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

// Light / Dark / System theme switch. The actual `data-theme` attribute is
// stamped by the inline script in the root layout before paint; this control
// just persists the choice and re-resolves it live. "system" clears the
// stored preference and follows the OS (kept in sync via a media listener).

type Choice = "light" | "dark" | "system";

function resolve(choice: Choice): "light" | "dark" {
  if (choice === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return choice;
}

function apply(choice: Choice) {
  document.documentElement.dataset.theme = resolve(choice);
}

/** Persist + apply a theme choice from anywhere (e.g. the command palette). */
export function setTheme(choice: Choice) {
  try {
    if (choice === "system") localStorage.removeItem("theme");
    else localStorage.setItem("theme", choice);
  } catch {
    /* ignore */
  }
  apply(choice);
}
export type ThemeChoice = Choice;

export function ThemeToggle({ collapsed }: { collapsed?: boolean }) {
  const [choice, setChoice] = useState<Choice>("system");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    try {
      const stored = localStorage.getItem("theme");
      setChoice(stored === "dark" || stored === "light" ? stored : "system");
    } catch {
      /* private mode */
    }
  }, []);

  // When following the OS, react to OS changes live.
  useEffect(() => {
    if (choice !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [choice]);

  function pick(next: Choice) {
    setChoice(next);
    try {
      if (next === "system") localStorage.removeItem("theme");
      else localStorage.setItem("theme", next);
    } catch {
      /* ignore */
    }
    apply(next);
  }

  const OPTIONS: { key: Choice; label: string; Icon: typeof Sun }[] = [
    { key: "light", label: "Light", Icon: Sun },
    { key: "dark", label: "Dark", Icon: Moon },
    { key: "system", label: "System", Icon: Monitor },
  ];

  // Collapsed rail: one button that cycles light → dark → system.
  if (collapsed) {
    const order: Choice[] = ["light", "dark", "system"];
    const Active = OPTIONS.find((o) => o.key === choice)!.Icon;
    return (
      <button
        type="button"
        aria-label={`Theme: ${choice}. Click to change.`}
        onClick={() => pick(order[(order.indexOf(choice) + 1) % order.length])}
        className="group relative inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        {/* suppressHydrationWarning: pre-mount the icon is a guess; the stored
            choice resolves on mount. */}
        <span suppressHydrationWarning>
          {mounted ? <Active className="h-4 w-4" /> : <Monitor className="h-4 w-4" />}
        </span>
      </button>
    );
  }

  return (
    <div className="segmented w-full justify-between p-0.5" role="group" aria-label="Theme">
      {OPTIONS.map(({ key, label, Icon }) => (
        <button
          key={key}
          type="button"
          aria-label={label}
          aria-pressed={mounted && choice === key}
          title={label}
          onClick={() => pick(key)}
          className={cn(
            "inline-flex h-6 flex-1 items-center justify-center rounded-full transition-colors",
            mounted && choice === key
              ? "segmented-on text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
}
