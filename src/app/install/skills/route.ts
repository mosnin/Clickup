import { INSTALLABLE_SKILLS, skillDigests } from "@/lib/agent-skills";

const SKILLS = INSTALLABLE_SKILLS.map((skill) => skill.slug);

const OFFICIAL_ORIGIN = "https://www.operate.to";

function publicOrigin(): string {
  const configured = process.env.OPERATE_PUBLIC_URL;
  if (!configured) return OFFICIAL_ORIGIN;
  try {
    const parsed = new URL(configured);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return OFFICIAL_ORIGIN;
    }
    return parsed.origin;
  } catch {
    return OFFICIAL_ORIGIN;
  }
}

export async function GET() {
  const origin = publicOrigin();
  // Same digests the manifest publishes, so "the installer verified this"
  // and "the manifest says you are current" can never mean different bytes.
  const skillFiles = await skillDigests();
  const downloads = skillFiles
    .map(
      ({ slug: skill, sha256 }) =>
        `mkdir -p "$staging_dir/${skill}"
curl -fsSL --retry 3 --retry-delay 1 "${origin}/skills/operate/${skill}" -o "$staging_dir/${skill}/SKILL.md"
verify_sha256 "${sha256}" "$staging_dir/${skill}/SKILL.md"`,
    )
    .join("\n");
  const installs = SKILLS.map(
    (skill) =>
      `mkdir -p "$target_dir/${skill}"\nmv "$staging_dir/${skill}/SKILL.md" "$target_dir/${skill}/SKILL.md"`,
  ).join("\n");
  const script = `#!/bin/sh
set -eu

target_dir="\${OPERATE_SKILLS_DIR:-.agents/skills}"
command -v curl >/dev/null 2>&1 || {
  echo "Operate skills installer requires curl." >&2
  exit 1
}

verify_sha256() {
  expected="$1"
  file="$2"
  if command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  elif command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  else
    echo "Operate skills installer requires shasum or sha256sum." >&2
    exit 1
  fi
  if [ "$actual" != "$expected" ]; then
    echo "Checksum verification failed for $file." >&2
    exit 1
  fi
}

staging_dir="$(mktemp -d "\${TMPDIR:-/tmp}/operate-skills.XXXXXX")"
trap 'rm -rf "$staging_dir"' EXIT HUP INT TERM

${downloads}

mkdir -p "$target_dir"
${installs}

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
