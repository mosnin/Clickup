"use client";

// The branch panel: the forge side of a room.
//
// **This is the claim the whole phase rests on.** A room has two views and they
// are genuinely two: the transcript draws what people said, this draws what the
// code did, and *neither can draw the other's rows* — not because either applies
// a filter, but because the two content sets are disjoint. `TIMELINE_CONTENT_KINDS`
// does not contain a patch and `ROOM_FORGE_KINDS` does not contain a message, so
// there is no filter here to forget and none there either. It is the same
// separation the forum has, pointed at a different pair of kinds.
//
// What makes the pane worth having rather than a second place to look: the
// verdicts and the argument are in one log, in one room, with one membership
// rule. Approving is not a form on another site that later gets pasted in — it
// is a signed event, by you, next to the sentence where somebody asked.
//
// Every button here is a mutation the server will also refuse. `canGovern`-style
// pre-hiding is deliberately *not* done for the merge control: `mergeReadiness`
// says what is missing and the button stays visible, because a control that
// silently disappears teaches nothing, while one that explains why it is off
// teaches the rule. The server is the boundary either way.

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation } from "convex/react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import type { ChatScope } from "@/lib/buzz/channel-types";
import {
  buildBranchRoom,
  mergeReadiness,
  normalizeBranchName,
  projectHref,
  shortCommit,
} from "@/lib/buzz/project";
import {
  bindBranch,
  postMerge,
  postPatch,
  postReview,
  setBranchState,
  useProjects,
  useRoomForge,
  actorMap,
} from "./projects-data";
import {
  BranchStateChip,
  EmptyNote,
  PatchBlock,
  StatusChip,
  agoOf,
  labelOf,
} from "./panels";

export function BranchPane({
  scope,
  channelId,
}: {
  scope: ChatScope | null;
  channelId: string;
}) {
  const { forge, error, subscriptions } = useRoomForge(scope, channelId);
  const actors = useMemo(() => actorMap(forge?.actors), [forge?.actors]);
  const room = useMemo(
    () => buildBranchRoom(channelId, forge?.events ?? []),
    [channelId, forge?.events],
  );
  const [expanded, setExpanded] = useState<string | null>(null);

  if (error) {
    return (
      <>
        {subscriptions}
        <p role="status" className="text-sm text-danger">
          {error}
        </p>
      </>
    );
  }

  if (forge === undefined) {
    return (
      <>
        {subscriptions}
        <p className="chat-quiet text-sm">Loading…</p>
      </>
    );
  }

  if (!room.binding) {
    return (
      <>
        {subscriptions}
        <BindRoom scope={scope} channelId={channelId} />
      </>
    );
  }

  const binding = room.binding;
  const readiness = mergeReadiness(room);

  return (
    <div className="space-y-4 pb-2">
      {subscriptions}

      <section>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold">
              {binding.title || binding.branch}
            </h3>
            <p className="chat-quiet mt-0.5 truncate text-xs">
              {binding.branch}
              {binding.targetBranch ? ` → ${binding.targetBranch}` : ""}
              {room.tip ? ` · ${shortCommit(room.tip)}` : ""}
            </p>
          </div>
          <BranchStateChip state={room.state} />
        </div>
        {forge.project ? (
          <p className="chat-quiet mt-2 text-xs">
            <Link
              href={projectHref(forge.project.id)}
              className="underline underline-offset-2"
            >
              {forge.project.name}
            </Link>{" "}
            · opened by {labelOf(actors, binding.by)} {agoOf(binding.at)}
          </p>
        ) : null}
      </section>

      <section className="space-y-2">
        <h4 className="chat-quiet text-tiny uppercase tracking-wider">Verdicts</h4>
        <div className="flex flex-wrap items-center gap-1.5">
          {room.check ? (
            <StatusChip outcome={room.check.outcome} />
          ) : (
            <span className="chat-quiet text-xs">No checks have reported.</span>
          )}
        </div>
        {room.reviews.length === 0 ? (
          <p className="chat-quiet text-xs">Nobody has reviewed this yet.</p>
        ) : (
          <ul className="space-y-1">
            {room.reviews.map((review) => (
              <li key={`${review.by}:${review.at}`} className="flex items-center gap-2">
                <StatusChip outcome={review.outcome} />
                <span className="min-w-0 flex-1 truncate text-xs">
                  {labelOf(actors, review.by)}
                  {/* A stale verdict is kept and marked, never dropped: "Ada
                      approved this, two pushes ago" is true and useful, and
                      hiding it reads as Ada never looking. */}
                  {review.current ? "" : " · against an older commit"}
                </span>
                <span className="chat-quiet shrink-0 text-tiny">
                  {agoOf(review.at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <BranchActions
        scope={scope}
        channelId={channelId}
        merged={room.state === "merged"}
        blockers={readiness.blockers}
      />

      <section className="space-y-2">
        <h4 className="chat-quiet text-tiny uppercase tracking-wider">
          Patches ({room.patches.length})
        </h4>
        <PostPatch scope={scope} channelId={channelId} />
        {room.patches.length === 0 ? (
          <p className="chat-quiet text-xs">
            Nothing has been pushed here yet. A coding agent or a CI runner posts
            patches with its own key through <code>buzz/projects:report</code>.
          </p>
        ) : (
          room.patches.map((patch) => (
            <PatchBlock
              key={patch.id}
              patch={patch}
              actors={actors}
              expanded={expanded === patch.id}
              onToggle={() => setExpanded(expanded === patch.id ? null : patch.id)}
            />
          ))
        )}
      </section>
    </div>
  );
}

/**
 * Approve, ask for changes, close, merge.
 *
 * The merge control shows its blockers instead of vanishing. `mergeReadiness` is
 * advisory by construction — there is no git here, so "ready" is a reading of
 * what the room has recorded rather than a promise a push will land — and the
 * copy says as much.
 */
function BranchActions({
  scope,
  channelId,
  merged,
  blockers,
}: {
  scope: ChatScope | null;
  channelId: string;
  merged: boolean;
  blockers: readonly string[];
}) {
  const { toast } = useToast();
  const review = useMutation(postReview);
  const merge = useMutation(postMerge);
  const setState = useMutation(setBranchState);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<unknown>, done: string) {
    if (!scope) return;
    setBusy(true);
    try {
      await action();
      toast(done);
    } catch (error) {
      toast(
        (error as { data?: string })?.data ??
          (error instanceof Error ? error.message : "That was refused"),
        { kind: "error" },
      );
    } finally {
      setBusy(false);
    }
  }

  if (!scope) return null;
  const args = { scopeType: scope.scopeType, scopeId: scope.scopeId, channelId };

  return (
    <section className="space-y-2">
      <h4 className="chat-quiet text-tiny uppercase tracking-wider">Decide</h4>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy || merged}
          onClick={() => void run(() => review({ ...args, outcome: "approved" }), "Approved")}
        >
          Approve
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy || merged}
          onClick={() =>
            void run(
              () => review({ ...args, outcome: "changes_requested" }),
              "Changes requested",
            )
          }
        >
          Request changes
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={busy || merged}
          onClick={() => void run(() => merge({ ...args }), "Merge recorded")}
        >
          Record merge
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy || merged}
          onClick={() =>
            void run(() => setState({ ...args, outcome: "closed" }), "Branch closed")
          }
        >
          Close
        </Button>
      </div>
      {!merged && blockers.length > 0 ? (
        <p className="chat-quiet text-xs">
          Not ready to merge: {blockers.join(" · ")}. Recording one anyway is
          allowed and is a decision you are signing for.
        </p>
      ) : null}
    </section>
  );
}

/**
 * Paste a patch into the room.
 *
 * The human half of the ingestion story, and it exists for the same reason the
 * agent door does rather than instead of it: a patch is a fact about the code,
 * and the room's job is to hold that fact next to the argument about it. Whoever
 * has the diff can put it there — the difference between a person and a runner
 * is *whose key signs it*, which the log records forever.
 *
 * Not a rich editor. A diff is bytes: markdown would turn a leading `+` into a
 * list and a leading `#` into a heading, so the field is a plain textarea and
 * `PatchBlock` draws what comes back in monospace.
 */
function PostPatch({ scope, channelId }: { scope: ChatScope | null; channelId: string }) {
  const { toast } = useToast();
  const post = useMutation(postPatch);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [commit, setCommit] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="panel tap-target w-full rounded-2xl px-4 py-3 text-left text-sm font-medium"
      >
        Post a patch…
      </button>
    );
  }

  async function submit() {
    if (!scope || body.trim().length === 0) return;
    setBusy(true);
    try {
      await post({
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        channelId,
        title: title.trim(),
        body,
        ...(commit.trim() ? { commit: commit.trim() } : {}),
      });
      toast("Patch posted");
      setTitle("");
      setBody("");
      setCommit("");
      setOpen(false);
    } catch (error) {
      toast(
        (error as { data?: string })?.data ??
          (error instanceof Error ? error.message : "That was refused"),
        { kind: "error" },
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel rounded-2xl p-4">
      <label className="block">
        <span className="chat-quiet text-tiny uppercase tracking-wider">Subject</span>
        <input
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          className="soft-field mt-1 w-full rounded-xl px-3 py-2 text-sm"
        />
      </label>
      <label className="mt-3 block">
        <span className="chat-quiet text-tiny uppercase tracking-wider">Diff</span>
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={6}
          placeholder="diff --git a/… b/…"
          className="soft-field mt-1 w-full rounded-xl px-3 py-2 font-mono text-xs"
        />
      </label>
      <label className="mt-3 block">
        <span className="chat-quiet text-tiny uppercase tracking-wider">Commit</span>
        <input
          value={commit}
          onChange={(event) => setCommit(event.target.value)}
          placeholder="40 or 64 hex characters"
          className="soft-field mt-1 w-full rounded-xl px-3 py-2 font-mono text-xs"
        />
      </label>
      <div className="mt-4 flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy || body.trim().length === 0}
          onClick={() => void submit()}
        >
          {busy ? "Posting…" : "Post patch"}
        </Button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className={cn("chat-quiet tap-target text-sm", busy && "pointer-events-none")}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Bind this room to a branch.
 *
 * Reachable from every room rather than only from a room that failed to bind,
 * because "any room can become the room for a branch" is the idea, not a repair
 * path. A room with no projects to bind to says so instead of offering an empty
 * picker.
 */
function BindRoom({ scope, channelId }: { scope: ChatScope | null; channelId: string }) {
  const { toast } = useToast();
  // The subscription must be rendered by whoever holds it — that is where the
  // query actually lives, and an unrendered one is a picker that never fills.
  const { page, subscriptions } = useProjects(scope);
  const bind = useMutation(bindBranch);
  const [address, setAddress] = useState("");
  const [branch, setBranch] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);

  const projects = page?.projects ?? [];
  const chosen = address || projects[0]?.project.repoAddress || "";
  const valid = normalizeBranchName(branch) !== null && chosen.length > 0;

  if (page !== undefined && projects.length === 0) {
    return (
      <>
        {subscriptions}
        <EmptyNote
          title="Not a branch room"
          body="Announce a repository under Projects first, then this room can be the room for one of its branches."
        />
      </>
    );
  }

  async function submit() {
    if (!scope || !valid) return;
    setBusy(true);
    try {
      await bind({
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        channelId,
        repoAddress: chosen,
        branch: branch.trim(),
        ...(target.trim() ? { targetBranch: target.trim() } : {}),
      });
      toast("This room is now a branch room");
    } catch (error) {
      toast(
        (error as { data?: string })?.data ??
          (error instanceof Error ? error.message : "That was refused"),
        { kind: "error" },
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 pb-2">
      {subscriptions}
      <p className="chat-quiet text-sm">
        Bind this room to a branch and its patches, checks, reviews and merge will
        be recorded here.
      </p>

      <label className="block">
        <span className="chat-quiet text-tiny uppercase tracking-wider">
          Repository
        </span>
        <select
          value={chosen}
          onChange={(event) => setAddress(event.target.value)}
          className="soft-field mt-1 w-full rounded-xl px-3 py-2 text-sm"
        >
          {projects.map(({ project }) => (
            <option key={project.id} value={project.repoAddress}>
              {project.name}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="chat-quiet text-tiny uppercase tracking-wider">Branch</span>
        <input
          value={branch}
          onChange={(event) => setBranch(event.target.value)}
          placeholder="feature/retry-budget"
          className="soft-field mt-1 w-full rounded-xl px-3 py-2 text-sm"
        />
      </label>

      <label className="block">
        <span className="chat-quiet text-tiny uppercase tracking-wider">
          Merging into
        </span>
        <input
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          placeholder="main"
          className="soft-field mt-1 w-full rounded-xl px-3 py-2 text-sm"
        />
      </label>

      <div className={cn("flex items-center gap-2", busy && "opacity-70")}>
        <Button type="button" size="sm" disabled={busy || !valid} onClick={() => void submit()}>
          {busy ? "Binding…" : "Bind"}
        </Button>
      </div>
    </div>
  );
}
