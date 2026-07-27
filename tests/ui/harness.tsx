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
 * The route the component believes it is on. Several surfaces derive
 * context from the URL — the sidebar picks which workspace's tree to show
 * from it — so a test that seeds workspace data has to say it is looking at
 * that workspace.
 */
export const navState = { pathname: "/dashboard" };

/** Set by each test before render; keyed by the function's dotted path. */
export const queryResults: QueryMap = {};
export const mutationCalls: { name: string; args: unknown }[] = [];

/** Reset between tests so one test's data can't leak into the next. */
export function resetHarness() {
  for (const key of Object.keys(queryResults)) delete queryResults[key];
  mutationCalls.length = 0;
  navState.pathname = "/dashboard";
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
      return undefined;
    };
  },
  useAction: () => async () => undefined,
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
  useToast: () => ({ toast: vi.fn() }),
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
