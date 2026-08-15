"use client";

import { Component, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Button } from "@/components/ui/button";

// Convex's useQuery rethrows server errors during render (useSyncExternalStore
// getSnapshot). Next.js error.tsx catches that for the page segment; this
// boundary sits inside the dashboard layout so a future query throw cannot
// replace the signed-in shell with the generic Application error page.

type Props = { children: ReactNode };
type State = { error: Error | null };

export class QueryErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("Dashboard query failed", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <EmptyState
        title="This screen hit a problem"
        message="Your workspace is safe. Try loading it again."
        action={
          <Button
            type="button"
            variant="outline"
            onClick={() => this.setState({ error: null })}
          >
            <RefreshCw aria-hidden />
            Try again
          </Button>
        }
      />
    );
  }
}
