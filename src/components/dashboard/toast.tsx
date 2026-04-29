"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Undo2, X } from "lucide-react";

// Lightweight toast queue for undoable actions. Pace's destructive
// actions go through soft-delete on the server, so the client only has
// to:
//   1. Optimistically vanish the row (Convex's reactive query already
//      does this for us once the soft-delete returns).
//   2. Show a 5-second toast with an Undo button that calls the
//      restore mutation.
//   3. Auto-dismiss when time runs out.
//
// `showUndo({ label, onUndo })` is the public API; everything else is
// implementation detail.

const DEFAULT_TIMEOUT_MS = 5000;

type ToastEntry = {
  id: number;
  label: string;
  onUndo?: () => unknown | Promise<unknown>;
  expiresAt: number;
};

type ToastContextValue = {
  show: (input: { label: string }) => void;
  showUndo: (input: {
    label: string;
    onUndo: () => unknown | Promise<unknown>;
  }) => void;
};

const ToastContext = createContext<ToastContextValue>({
  show: () => {},
  showUndo: () => {},
});

export function useToast() {
  return useContext(ToastContext);
}

let nextId = 1;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  const dismiss = useCallback((id: number) => {
    setToasts((curr) => curr.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (entry: Omit<ToastEntry, "id" | "expiresAt">) => {
      const id = nextId++;
      const expiresAt = Date.now() + DEFAULT_TIMEOUT_MS;
      setToasts((curr) => [...curr, { ...entry, id, expiresAt }]);
      const timer = setTimeout(() => dismiss(id), DEFAULT_TIMEOUT_MS);
      timersRef.current.set(id, timer);
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      show: ({ label }) => push({ label }),
      showUndo: ({ label, onUndo }) => push({ label, onUndo }),
    }),
    [push],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role="region"
        aria-live="polite"
        className="fixed bottom-4 left-1/2 z-[55] flex -translate-x-1/2 flex-col items-center gap-2"
      >
        {toasts.map((t) => (
          <ToastRow
            key={t.id}
            toast={t}
            onDismiss={() => dismiss(t.id)}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastRow({
  toast,
  onDismiss,
}: {
  toast: ToastEntry;
  onDismiss: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-full border border-border bg-foreground px-4 py-2 text-sm text-background shadow-lg">
      <span>{toast.label}</span>
      {toast.onUndo && (
        <button
          type="button"
          onClick={async () => {
            try {
              await toast.onUndo?.();
            } finally {
              onDismiss();
            }
          }}
          className="inline-flex items-center gap-1 rounded-full bg-background/15 px-2 py-0.5 text-xs font-medium hover:bg-background/25"
        >
          <Undo2 className="h-3 w-3" /> Undo
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="text-background/60 hover:text-background"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
