import type { Metadata } from "next";
import { ProjectScreen } from "@/components/chat/projects";

export const metadata: Metadata = { title: "Project · Chat" };

// `/chat/projects/<owner-hex>:<slug>`.
//
// The id is the NIP-34 address minus its kind prefix, which is what makes it
// canonical: `30617` is keyed by `(author, d)`, so a repo called `api` announced
// by two people is two repositories and only the owner half tells them apart.
// Forks make slugs non-unique on purpose, so a bare slug in a link would resolve
// to whichever announcement came back first.

export default async function ChatProject({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <ProjectScreen projectId={decodeURIComponent(projectId)} />;
}
