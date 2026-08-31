"use client";

// `/chat/projects/<owner>:<slug>` — one repository, and the rooms its branches
// live in.
//
// The screen is three readings of the same events, which is why it is a
// segmented control rather than three routes: **Branches** is the state of the
// work, **Activity** is the order it happened in, and **About** is what the
// announcement says. Every number on all three comes from the same fold
// (`buildBranchRoom`) over the same window, so the tabs cannot disagree — the
// failure mode a per-tab query would have, where the branch count says four and
// the feed shows five.
//
// The rooms themselves are links out. A branch is not a sub-page of a project;
// it is a channel, in the sidebar, with a transcript and a composer. Following
// one lands you in the conversation rather than in a read-only mirror of it.

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { createChannelError } from "@/lib/buzz/create-channel";
import { useChatShell } from "@/components/chat/shell/chat-shell";
import { ContentSurface } from "@/components/chat/shell/surfaces";
import { channelHref } from "@/components/chat/shell/layout";
import {
  buildBranchRoom,
  normalizeBranchName,
  projectActivity,
  refsFromRepoState,
  shortCommit,
  summarizeProject,
  type BranchRoom,
} from "@/lib/buzz/project";
import { useProject, useOpenBranchRoom, actorMap } from "./projects-data";
import { ActivityFeed, BranchRow, EmptyNote, StatPills, labelOf } from "./panels";

const TABS = [
  { id: "branches", label: "Branches" },
  { id: "activity", label: "Activity" },
  { id: "about", label: "About" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function ProjectScreen({ projectId }: { projectId: string }) {
  const { scope } = useChatShell();
  const { page, error, subscriptions } = useProject(scope, projectId);
  const [tab, setTab] = useState<TabId>("branches");

  const actors = useMemo(() => actorMap(page?.actors), [page?.actors]);
  const rooms = useMemo<BranchRoom[]>(
    () => (page?.rooms ?? []).map((room) => buildBranchRoom(room.channelId, room.events)),
    [page?.rooms],
  );
  const summary = useMemo(
    () => (page ? summarizeProject(page.project, rooms) : null),
    [page, rooms],
  );
  const refs = useMemo(
    () => (page?.refState ? refsFromRepoState(page.refState) : null),
    [page?.refState],
  );

  return (
    <ContentSurface>
      {subscriptions}
      <div className="chat-scroll min-h-0 flex-1">
        <div className="mx-auto w-full max-w-4xl px-5 py-8 sm:px-8">
          <p className="chat-quiet text-xs">
            <Link href="/chat/projects" className="underline underline-offset-2">
              Projects
            </Link>
          </p>

          {error ? (
            <p role="status" className="mt-6 text-sm text-danger">
              {error}
            </p>
          ) : page === undefined ? (
            <p className="chat-quiet mt-6 text-sm">Loading…</p>
          ) : page === null ? (
            <div className="mt-6">
              <EmptyNote
                title="No such project here"
                body="A repository belongs to one community. This one may have been announced in another — pick one from the rail."
              />
            </div>
          ) : (
            <>
              <header className="mt-2">
                <h1 className="text-2xl font-bold tracking-tight">{page.project.name}</h1>
                <div className="title-rule" />
                {page.project.description ? (
                  <p className="mt-4 text-sm">{page.project.description}</p>
                ) : null}
                <p className="chat-quiet mt-2 text-xs">
                  Announced by {labelOf(actors, page.project.owner)}
                  {page.project.visibility === "unlisted" ? " · Unlisted" : ""}
                </p>
              </header>

              {summary ? (
                <div className="mt-6">
                  <StatPills
                    stats={[
                      ["Branch rooms", String(summary.branchRooms)],
                      ["Open", String(summary.openBranchRooms)],
                      ["Patches", String(summary.patches)],
                      ["People", String(summary.participants.length)],
                    ]}
                  />
                </div>
              ) : null}

              <div
                className="segmented mt-6 inline-flex"
                role="tablist"
                aria-label="Project view"
              >
                {TABS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="tab"
                    aria-selected={tab === option.id}
                    onClick={() => setTab(option.id)}
                    className={cn(
                      "tap-target rounded-full px-3 py-1 text-xs font-medium",
                      tab === option.id && "segmented-on",
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>

              <div className="mt-4">
                {tab === "branches" ? (
                  <section className="space-y-3">
                    <OpenBranchRoom repoAddress={page.project.repoAddress} />
                    {rooms.length === 0 ? (
                      <EmptyNote
                        title="No branch rooms yet"
                        body="Open one and the branch's patches, checks, reviews and merge will live in it."
                      />
                    ) : (
                      rooms.map((room) => (
                        <BranchRow
                          key={room.channelId}
                          room={room}
                          href={channelHref(room.channelId)}
                          actors={actors}
                        />
                      ))
                    )}
                  </section>
                ) : tab === "activity" ? (
                  <section className="panel rounded-2xl p-4">
                    <ActivityFeed
                      items={projectActivity(rooms)}
                      actors={actors}
                      hrefFor={channelHref}
                    />
                  </section>
                ) : (
                  <section className="panel space-y-4 rounded-2xl p-4">
                    <Facts
                      rows={[
                        ["Address", page.project.repoAddress],
                        ["Slug", page.project.dtag],
                        [
                          "Clone",
                          page.project.cloneUrls.join(", ") ||
                            "Not published — nothing is hosted here",
                        ],
                        ["Web", page.project.webUrl || "—"],
                        [
                          "Maintainers",
                          page.project.maintainers
                            .map((pubkey) => labelOf(actors, pubkey))
                            .join(", "),
                        ],
                        [
                          "Default branch",
                          refs?.head ?? "Unknown — no ref state published",
                        ],
                      ]}
                    />
                    {refs && refs.branches.length > 0 ? (
                      <div>
                        <h3 className="chat-quiet text-tiny uppercase tracking-wider">
                          Refs
                        </h3>
                        <ul className="mt-2 space-y-1">
                          {refs.branches.map((ref) => (
                            <li key={ref.name} className="flex gap-3 text-sm">
                              <span className="min-w-0 flex-1 truncate">{ref.name}</span>
                              <span className="chat-quiet shrink-0 font-mono text-xs">
                                {shortCommit(ref.oid)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {/* Named rather than left to be discovered: a project page
                        with no "clone" button is a surprise unless it says why. */}
                    <p className="chat-quiet text-xs">
                      Ref state is published by whoever mirrors this repository —
                      there is no git hosting in this deployment, so a branch room
                      is a record of a branch rather than a copy of it.
                    </p>
                  </section>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </ContentSurface>
  );
}

function Facts({ rows }: { rows: readonly [string, string][] }) {
  return (
    <dl className="space-y-1 text-sm">
      {rows.map(([term, value]) => (
        <div key={term} className="flex gap-3 py-1">
          <dt className="chat-quiet w-32 shrink-0 text-xs">{term}</dt>
          <dd className="min-w-0 flex-1 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Open a branch room.
 *
 * Two writes, and the form says so when the second one fails: the room is
 * created through `buzz/channels:create` — the same path every other room takes,
 * not a copy of it — and then bound. See `useOpenBranchRoom` and
 * `buzz/projects:bindBranch` for why that is not one transaction and why the
 * failure is recoverable rather than lost.
 */
function OpenBranchRoom({ repoAddress }: { repoAddress: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const open = useOpenBranchRoom(useChatShell().scope);
  const [expanded, setExpanded] = useState(false);
  const [branch, setBranch] = useState("");
  const [target, setTarget] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const valid = normalizeBranchName(branch) !== null;

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="panel tap-target w-full rounded-2xl px-4 py-3 text-left text-sm font-medium"
      >
        Open a branch room…
      </button>
    );
  }

  async function submit() {
    setBusy(true);
    try {
      const { channelId } = await open({
        repoAddress,
        branch: branch.trim(),
        ...(target.trim() ? { targetBranch: target.trim() } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
      });
      toast("Branch room opened");
      router.push(channelHref(channelId));
    } catch (error) {
      toast(createChannelError(error, "branch room"), { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel rounded-2xl p-4">
      <label className="block">
        <span className="chat-quiet text-tiny uppercase tracking-wider">Branch</span>
        <input
          autoFocus
          value={branch}
          onChange={(event) => setBranch(event.target.value)}
          placeholder="feature/retry-budget"
          className="soft-field mt-1 w-full rounded-xl px-3 py-2 text-sm"
        />
      </label>
      {branch.trim().length > 0 && !valid ? (
        <p className="mt-1 text-xs text-danger">That is not a branch name.</p>
      ) : null}

      <label className="mt-3 block">
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

      <label className="mt-3 block">
        <span className="chat-quiet text-tiny uppercase tracking-wider">
          What it is for
        </span>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          className="soft-field mt-1 w-full rounded-xl px-3 py-2 text-sm"
        />
      </label>

      <div className="mt-4 flex items-center gap-2">
        <Button type="button" size="sm" disabled={busy || !valid} onClick={() => void submit()}>
          {busy ? "Opening…" : "Open room"}
        </Button>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className={cn("chat-quiet tap-target text-sm", busy && "pointer-events-none")}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
