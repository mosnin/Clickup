import { vi } from "vitest";
import type { ReactNode } from "react";
import { SidebarProvider } from "@/components/ui/sidebar";

// A controllable stand-in for the Convex React bindings.
//
// The components under test are pure functions of their query results, so
// the honest way to test "does the project page render its lists" is to
// hand it query results and look at the DOM — not to spin up a backend.
// convex-test already covers the backend; this covers the half it can't.

export type QueryMap = Record<string, unknown>;

/**
 * What a recorded toast looks like.
 *
 * Recorded rather than swallowed because the app's destructive actions are
 * *deferred* — the mutation runs when the undo window closes, not when you
 * click. A test that only checks "the mutation was called" would pass on a
 * delete that fires immediately, which is precisely the bug the pattern
 * exists to prevent. So a test fires `onExpire` itself and asserts what
 * happens on each side of that line.
 */
export type ToastCall = {
  message: string;
  opts?: {
    kind?: string;
    action?: { label: string; onClick: () => void };
    onExpire?: () => void;
  };
};

/**
 * The route the component believes it is on. Several surfaces derive
 * context from the URL — the sidebar picks which workspace's tree to show
 * from it — so a test that seeds workspace data has to say it is looking at
 * that workspace.
 */
export const navState = { pathname: "/dashboard" };

/** Set by each test before render; keyed by the function's dotted path. */
export const queryResults: QueryMap = {};
export const mutationCalls: { name: string; args: unknown }[] = [];
export const toastCalls: ToastCall[] = [];
/** Answers for `useAction`, keyed by dotted path — same idea as queries. */
export const actionResults: QueryMap = {};
/** Optional throw/return for a mutation path, so a test can exercise failure. */
export const mutationHandlers: Record<
  string,
  (args: unknown) => unknown | Promise<unknown>
> = {};

/** Reset between tests so one test's data can't leak into the next. */
export function resetHarness() {
  for (const key of Object.keys(queryResults)) delete queryResults[key];
  for (const key of Object.keys(actionResults)) delete actionResults[key];
  for (const key of Object.keys(mutationHandlers)) delete mutationHandlers[key];
  mutationCalls.length = 0;
  toastCalls.length = 0;
  navState.pathname = "/dashboard";
}

/** Every mutation call at a path, so a test can assert the args it sent. */
export function calls(path: string): unknown[] {
  return mutationCalls.filter((c) => c.name === path).map((c) => c.args);
}

/**
 * The generated `api` object is a Proxy, so a component's
 * `api.pages.get` reference carries no name at runtime. This mock replaces
 * it with one that records its own path, which is what lets a test say
 * "when pages.get is asked, answer this".
 */
function pathProxy(prefix = ""): unknown {
  return new Proxy(
    { __path: prefix },
    {
      get(target, prop) {
        if (prop === "__path") return target.__path;
        if (typeof prop !== "string") return undefined;
        return pathProxy(prefix ? `${prefix}.${prop}` : prop);
      },
    },
  );
}

vi.mock("@convex/_generated/api", () => ({ api: pathProxy() }));

vi.mock("convex/react", () => ({
  useQuery: (ref: { __path?: string }, args: unknown) => {
    if (args === "skip") return undefined;
    const path = ref?.__path ?? "";
    // `undefined` means "still loading" to every component here, so a key
    // that was never set exercises the skeleton path — a state worth being
    // able to test deliberately.
    return queryResults[path];
  },
  useMutation: (ref: { __path?: string }) => {
    const path = ref?.__path ?? "";
    return async (args: unknown) => {
      mutationCalls.push({ name: path, args });
      if (mutationHandlers[path]) return mutationHandlers[path](args);
      return undefined;
    };
  },
  useAction: (ref: { __path?: string }) => {
    const path = ref?.__path ?? "";
    return async (args: unknown) => {
      mutationCalls.push({ name: path, args });
      return actionResults[path];
    };
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => navState.pathname,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@clerk/nextjs", () => ({
  useUser: () => ({
    user: { fullName: "Ada Lovelace", primaryEmailAddress: null },
  }),
  UserButton: () => null,
}));

vi.mock("@/components/toast", () => ({
  useToast: () => ({
    toast: (message: string, opts?: ToastCall["opts"]) => {
      toastCalls.push({ message, opts });
    },
  }),
  ToastProvider: ({ children }: { children: ReactNode }) => children,
}));

/**
 * Renders inside the providers the dashboard shell normally supplies.
 * PageHeader reads sidebar context, so a bare render of any page throws —
 * which is a fact about the shell, not a bug in the page.
 */
export function DashboardShell({ children }: { children: ReactNode }) {
  return <SidebarProvider>{children}</SidebarProvider>;
}
