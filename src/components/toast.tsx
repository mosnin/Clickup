"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { AnimatePresence, motion, SPRING } from "@/components/motion";

// App-wide toast system. One stack, bottom-center, popover-surface pills —
// the same voice everywhere. Two jobs:
//
//   1. Feedback: toast("Saved") / toast("Couldn't move task", { kind: "error" })
//   2. Undo-able deletes: instead of window.confirm, hide the row locally,
//      then toast("Agent deleted", { action: {...Undo}, onExpire: commit }).
//      onExpire runs when the toast times out or is dismissed — the
//      destructive mutation only happens after the undo window closes.
//
// Mounted once in the dashboard layout via <ToastProvider>.

export type ToastKind = "success" | "error" | "info";

type ToastOptions = {
  kind?: ToastKind;
  /** ms before auto-dismiss. Defaults to 4000 (6000 when there's an action). */
  duration?: number;
  /** Renders a bold action button (e.g. Undo). Clicking it skips onExpire. */
  action?: { label: string; onClick: () => void };
  /** Runs when the toast times out or is dismissed — NOT when the action is
   * clicked. Use for deferred destructive commits. */
  onExpire?: () => void;
};

type ToastItem = {
  id: number;
  message: string;
  kind: ToastKind;
  action?: { label: string; onClick: () => void };
  onExpire?: () => void;
};

type ToastContextValue = {
  toast: (message: string, options?: ToastOptions) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

let nextId = 1;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const finish = useCallback((id: number, runExpire: boolean) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((cur) => {
      const item = cur.find((t) => t.id === id);
      if (item && runExpire) item.onExpire?.();
      return cur.filter((t) => t.id !== id);
    });
  }, []);

  const toast = useCallback(
    (message: string, options?: ToastOptions) => {
      const id = nextId++;
      const item: ToastItem = {
        id,
        message,
        kind: options?.kind ?? "success",
        action: options?.action,
        onExpire: options?.onExpire,
      };
      setToasts((cur) => [...cur.slice(-2), item]);
      const duration = options?.duration ?? (options?.action ? 6000 : 4000);
      timers.current.set(
        id,
        setTimeout(() => finish(id, true), duration),
      );
    },
    [finish],
  );

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-[70] flex flex-col items-center gap-2 px-4"
      >
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.97 }}
              transition={SPRING}
              className="pointer-events-auto flex max-w-md items-center gap-2.5 rounded-lg border border-border bg-popover py-2 pl-4 pr-2 text-sm text-popover-foreground shadow-lg"
            >
              {t.kind === "success" ? (
                <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-positive" />
              ) : t.kind === "error" ? (
                <XCircle className="h-4 w-4 flex-shrink-0 text-destructive" />
              ) : (
                <Info className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden">
                {t.message}
              </span>
              {t.action ? (
                // Undoable deferred action: the only controls are Undo (cancel
                // the commit) or letting it auto-expire (commit). No separate X
                // — a reflexive dismiss must never silently confirm a delete.
                <button
                  type="button"
                  onClick={() => {
                    t.action?.onClick();
                    finish(t.id, false);
                  }}
                  className="flex-shrink-0 rounded-full px-3 py-1 font-semibold underline-offset-2 hover:bg-accent hover:underline"
                >
                  {t.action.label}
                </button>
              ) : (
                <button
                  type="button"
                  aria-label="Dismiss"
                  onClick={() => finish(t.id, true)}
                  className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-70 hover:bg-accent hover:opacity-100"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
