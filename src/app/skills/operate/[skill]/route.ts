import { readFile } from "node:fs/promises";
import path from "node:path";

const SKILLS = new Set([
  "operate-plan",
  "operate-dispatch",
  "operate-worker",
  "operate-daily-ops",
  "operate-recovery",
  "operate-assurance",
]);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ skill: string }> },
) {
  const { skill } = await params;
  if (!SKILLS.has(skill)) {
    return new Response("Skill not found", { status: 404 });
  }
  const content = await readFile(
    path.join(
      process.cwd(),
      "plugins",
      "operate",
      "skills",
      skill,
      "SKILL.md",
    ),
    "utf8",
  );
  return new Response(content, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
      "Content-Disposition": `inline; filename="${skill}-SKILL.md"`,
    },
  });
}
