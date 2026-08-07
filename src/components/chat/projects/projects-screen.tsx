"use client";

// `/chat/projects` — what this community is building.
//
// **Deliberately not four tabs.** §2.5's list screen is Overview · Repositories
// · Pull Requests · Issues, and two of those do not exist here for reasons this
// phase decided rather than deferred: a pull request *is* a branch room, so a
// list of them is a list of rooms and it lives on the project it belongs to (and
// in the sidebar, where rooms live); and issues are named but not built (see
// `KIND_GIT_ISSUE`). A tab that produced an empty pane would be the "control
// that produces a stub" CLAUDE.md refuses, and a tab that duplicated the sidebar
// would be a second place to find the same room.
//
// So this screen answers exactly the question its data can answer: what
// repositories exist here, who announced them, how much is moving in each, and
// how do I announce another. Collections (kind 30621) group the cards and
// nothing else — a grouping is one person's bookmark list and confers no
// authority over any repository in it (§2.1).

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation } from "convex/react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";
import { useChatShell } from "@/components/chat/shell/chat-shell";
import { ContentSurface } from "@/components/chat/shell/surfaces";
import { projectHref, projectSlug, type Project } from "@/lib/buzz/project";
import { announceProject, useProjects, actorMap } from "./projects-data";
import { EmptyNote, StatPills, labelOf } from "./panels";

export function ProjectsScreen() {
  const { scope } = useChatShell();
  const { page, error, subscriptions } = useProjects(scope);
  const actors = useMemo(() => actorMap(page?.actors), [page?.actors]);

  // Memoized rather than `?? []` inline: a fresh empty array every render is a
  // fresh dependency every render, and the grouping below would recompute on
  // every keystroke in the announce form.
  const projects = useMemo(() => page?.projects ?? [], [page?.projects]);
  const groups = useMemo(() => page?.groups ?? [], [page?.groups]);

  // Every repository named by a collection, so a card is drawn once: under its
  // collection when it has one, and in "Everything else" when it does not.
  const grouped = useMemo(() => {
    const claimed = new Set<string>();
    const sections = groups.map((group) => {
      const members = projects.filter((row) => {
        if (!group.memberAddresses.includes(row.project.repoAddress)) return false;
        claimed.add(row.project.repoAddress);
        return true;
      });
      return { id: group.slug, label: group.name || group.slug, members };
    });
    const rest = projects.filter((row) => !claimed.has(row.project.repoAddress));
    return { sections: sections.filter((s) => s.members.length > 0), rest };
  }, [groups, projects]);

  const totalRooms = projects.reduce((sum, row) => sum + row.branchRooms, 0);

  return (
    <ContentSurface>
      {subscriptions}
      <div className="chat-scroll min-h-0 flex-1">
        <div className="mx-auto w-full max-w-4xl px-5 py-8 sm:px-8">
          <header>
            <h1 className="text-2xl font-bold tracking-tight">Projects</h1>
            <div className="title-rule" />
            <p className="chat-quiet mt-4 text-sm">
              A branch becomes a room. Patches, checks, reviews and the merge land
              in that room alongside the conversation about them, so the channel is
              the record of why the code exists.
            </p>
          </header>

          {error ? (
            <p role="status" className="mt-6 text-sm text-danger">
              {error}
            </p>
          ) : null}

          <div className="mt-6">
            <StatPills
              stats={[
                ["Repositories", page ? String(projects.length) : "—"],
                ["Branch rooms", page ? String(totalRooms) : "—"],
                ["Collections", page ? String(groups.length) : "—"],
              ]}
            />
          </div>

          <div className="mt-6">
            <AnnounceProject />
          </div>

          {page === undefined ? (
            <p className="chat-quiet mt-8 text-sm">Loading projects…</p>
          ) : projects.length === 0 ? (
            <div className="mt-8">
              <EmptyNote
                title="No projects yet"
                body="Announce a repository to give its branches somewhere to live."
              />
            </div>
          ) : (
            <div className="mt-8 space-y-8">
              {grouped.sections.map((section) => (
                <section key={section.id}>
                  <h2 className="chat-quiet text-tiny uppercase tracking-wider">
                    {section.label}
                  </h2>
                  <ProjectCards rows={section.members} actors={actors} />
                </section>
              ))}
              {grouped.rest.length > 0 ? (
                <section>
                  {grouped.sections.length > 0 ? (
                    <h2 className="chat-quiet text-tiny uppercase tracking-wider">
                      Everything else
                    </h2>
                  ) : null}
                  <ProjectCards rows={grouped.rest} actors={actors} />
                </section>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </ContentSurface>
  );
}

function ProjectCards({
  rows,
  actors,
}: {
  rows: readonly { project: Project; branchRooms: number; lastActivityAt: number }[];
  actors: ReturnType<typeof actorMap>;
}) {
  return (
    <ul className="mt-3 grid gap-3 sm:grid-cols-2">
      {rows.map(({ project, branchRooms, lastActivityAt }) => (
        <li key={project.id}>
          <Link
            href={projectHref(project.id)}
            className="panel lift block h-full rounded-2xl p-4 no-underline"
          >
            <p className="truncate text-sm font-semibold">{project.name}</p>
            <p className="chat-quiet mt-1 line-clamp-2 text-xs">
              {project.description || "No description."}
            </p>
            <p className="chat-quiet mt-3 truncate text-tiny">
              {labelOf(actors, project.owner)} ·{" "}
              {branchRooms === 1 ? "1 branch room" : `${branchRooms} branch rooms`}
              {lastActivityAt > 0 ? ` · ${timeAgo(lastActivityAt)}` : ""}
            </p>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * Announce a repository.
 *
 * In place, on the screen the result lands on — never a settings page and never
 * a modal that hides the list it is adding to. The slug is shown as it is
 * derived rather than asked for, because the slug is half the address every
 * branch room joins on and a person who cannot see it cannot notice that
 * "Payments API" and "payments-api" are the same repository.
 */
function AnnounceProject() {
  const { scope } = useChatShell();
  const { toast } = useToast();
  const announce = useMutation(announceProject);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [cloneUrl, setCloneUrl] = useState("");
  const [busy, setBusy] = useState(false);

  const slug = projectSlug(name);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="panel tap-target w-full rounded-2xl px-4 py-3 text-left text-sm font-medium"
      >
        Announce a repository…
      </button>
    );
  }

  async function submit() {
    if (!scope || !slug) return;
    setBusy(true);
    try {
      await announce({
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(cloneUrl.trim() ? { cloneUrls: [cloneUrl.trim()] } : {}),
      });
      toast("Repository announced");
      setName("");
      setDescription("");
      setCloneUrl("");
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
        <span className="chat-quiet text-tiny uppercase tracking-wider">Name</span>
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Payments API"
          className="soft-field mt-1 w-full rounded-xl px-3 py-2 text-sm"
        />
      </label>
      <p className="chat-quiet mt-1 text-xs">
        {slug ? `Addressed as ${slug}` : "A project needs a name."}
      </p>

      <label className="mt-3 block">
        <span className="chat-quiet text-tiny uppercase tracking-wider">
          Description
        </span>
        <input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className="soft-field mt-1 w-full rounded-xl px-3 py-2 text-sm"
        />
      </label>

      <label className="mt-3 block">
        <span className="chat-quiet text-tiny uppercase tracking-wider">
          Clone URL
        </span>
        <input
          value={cloneUrl}
          onChange={(event) => setCloneUrl(event.target.value)}
          placeholder="https://…"
          className="soft-field mt-1 w-full rounded-xl px-3 py-2 text-sm"
        />
      </label>
      {/* Honest about what this deployment is: the URL is a pointer to somebody
          else's git host, because there is no git hosting here. Saying so beats
          a field that looks like it provisions one. */}
      <p className="chat-quiet mt-1 text-xs">
        Where the code actually lives. Nothing is hosted here.
      </p>

      <div className="mt-4 flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy || slug.length === 0}
          onClick={() => void submit()}
        >
          {busy ? "Announcing…" : "Announce"}
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
