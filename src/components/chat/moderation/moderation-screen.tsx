"use client";

// The moderation route's body: the shell's content surface, the queue inside
// it, and a boundary that turns "you are not a moderator" into a sentence.
//
// The boundary is doing real work here rather than being defensive habit. The
// queue query **throws** for a non-moderator — that is the server's gate, and
// it is the only gate — so without a boundary the whole Chat shell would
// unmount for anybody who opened the URL out of curiosity. Catching it and
// printing the server's own reason is both the correct UX and the honest one:
// the refusal a person reads is the refusal the API gives.

import { Component, type ReactNode } from "react";
import { useChatShell } from "../shell/chat-shell";
import { ContentSurface } from "../shell/surfaces";
import { ModerationQueuePanel } from "./queue-panel";

export function ModerationScreen() {
  const { scope } = useChatShell();
  return (
    <ContentSurface>
      <div className="chat-scroll min-h-0 flex-1">
        <ModerationBoundary>
          <ModerationQueuePanel scope={scope} />
        </ModerationBoundary>
      </div>
    </ContentSurface>
  );
}

class ModerationBoundary extends Component<
  { children: ReactNode },
  { message: string | null }
> {
  state: { message: string | null } = { message: null };

  static getDerivedStateFromError(error: unknown) {
    return {
      message:
        (error as { data?: string })?.data ??
        (error instanceof Error ? error.message : "Moderation could not be loaded"),
    };
  }

  render() {
    if (this.state.message === null) return this.props.children;
    return (
      <div className="mx-auto w-full max-w-2xl px-5 py-8 sm:px-8">
        <h1 className="text-2xl font-bold tracking-tight">Moderation</h1>
        <div className="title-rule" />
        <p role="status" className="mt-6 text-sm text-danger">
          {this.state.message}
        </p>
      </div>
    );
  }
}
