const SKILLS = [
  "operate-plan",
  "operate-dispatch",
  "operate-worker",
  "operate-daily-ops",
  "operate-recovery",
  "operate-assurance",
  "operate-decisions",
];

export function GET(request: Request) {
  const origin = new URL(request.url).origin;
  const downloads = SKILLS.map(
    (skill) =>
      `mkdir -p "$target_dir/${skill}"\ncurl -fsSL "${origin}/skills/operate/${skill}" -o "$target_dir/${skill}/SKILL.md"`,
  ).join("\n");
  const script = `#!/bin/sh
set -eu

target_dir="\${OPERATE_SKILLS_DIR:-.agents/skills}"
command -v curl >/dev/null 2>&1 || {
  echo "Operate skills installer requires curl." >&2
  exit 1
}

mkdir -p "$target_dir"
${downloads}

echo "Installed ${SKILLS.length} Operate skills in $target_dir"
echo "Set OPERATE_SKILLS_DIR=.claude/skills to install into a Claude-specific project directory."
`;
  return new Response(script, {
    headers: {
      "Content-Type": "text/x-shellscript; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
      "Content-Disposition": 'inline; filename="install-operate-skills.sh"',
    },
  });
}
