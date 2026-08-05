import { readSkill, SKILL_SLUGS } from "@/lib/agent-skills";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ skill: string }> },
) {
  const { skill } = await params;
  // The allow-list is what keeps this from being a path traversal into the
  // repo: `skill` comes straight from the URL and is otherwise joined onto
  // a filesystem path.
  if (!SKILL_SLUGS.has(skill)) {
    return new Response("Skill not found", { status: 404 });
  }
  const content = (await readSkill(skill)).toString("utf8");
  return new Response(content, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
      "Content-Disposition": `inline; filename="${skill}-SKILL.md"`,
    },
  });
}
