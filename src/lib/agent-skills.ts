import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

// The installable skill set, in one place.
//
// This list was previously written out twice — once in /skills/operate/[skill]
// to decide what may be served, once in /install/skills to build the installer
// — and the manifest would have made three. Three hand-maintained copies of
// one list is how a skill ships that nobody can install.

export type SkillDescriptor = {
  slug: string;
  /** One line, shown to a human choosing what to install. */
  summary: string;
};

export const INSTALLABLE_SKILLS: SkillDescriptor[] = [
  {
    slug: "operate-plan",
    summary:
      "Turn a confirmed brief, PRD, or transcript into an auditable multi-workstream execution plan.",
  },
  {
    slug: "operate-worker",
    summary:
      "Execute an assigned task safely: acknowledge context, claim, run, heartbeat, submit evidence.",
  },
  {
    slug: "operate-dispatch",
    summary:
      "Release and monitor parallel execution waves using dependencies, capabilities and capacity.",
  },
  {
    slug: "operate-daily-ops",
    summary:
      "Produce a daily operating brief: completed work, active runs, overdue items, what needs a human.",
  },
  {
    slug: "operate-decisions",
    summary:
      "Preserve and propagate operating-policy changes as immutable, versioned decisions.",
  },
  {
    slug: "operate-recovery",
    summary:
      "Diagnose and recover stalled, failed or abandoned work without duplicating it.",
  },
  {
    slug: "operate-assurance",
    summary:
      "Prove an execution plan achieved its original objective by collecting artifact evidence.",
  },
];

export const SKILL_SLUGS = new Set(INSTALLABLE_SKILLS.map((s) => s.slug));

export function skillPath(slug: string) {
  return path.join(process.cwd(), "plugins", "operate", "skills", slug, "SKILL.md");
}

export async function readSkill(slug: string) {
  return await readFile(skillPath(slug));
}

// The content hash IS the version, and that is the point.
//
// A `version: 3` column is maintained by a person and therefore forgotten —
// the skill changes, the number doesn't, and every agent that trusted it
// stays on stale instructions believing it is current. A digest of the file
// cannot be forgotten and changes exactly when the skill changes. Same
// argument as generating /start from the registry rather than writing it,
// and the installer already verifies against this digest.
export async function skillDigests(): Promise<
  { slug: string; summary: string; sha256: string }[]
> {
  return await Promise.all(
    INSTALLABLE_SKILLS.map(async ({ slug, summary }) => ({
      slug,
      summary,
      sha256: createHash("sha256")
        .update(await readSkill(slug))
        .digest("hex"),
    })),
  );
}

// The shell that downloads, verifies and installs the skills.
//
// Shared by /install/skills (which wraps it in a standalone script) and
// /connect (which embeds it mid-flow while a human is signing in). Two
// copies of a checksum-verifying installer is two places for a verification
// step to quietly go missing from.
//
// POSIX sh only — no bash-isms, no jq. The machines running this are as
// often a slim container as a laptop.
export function skillInstallFragment(
  origin: string,
  digests: { slug: string; sha256: string }[],
  opts: { targetVar?: string; quiet?: boolean } = {},
) {
  const target = opts.targetVar ?? "target_dir";
  const say = (text: string) => (opts.quiet ? "" : `echo "${text}"\n`);
  const steps = digests
    .map(
      ({ slug, sha256 }) => `mkdir -p "$staging_dir/${slug}"
curl -fsSL --retry 3 --retry-delay 1 "${origin}/skills/operate/${slug}" -o "$staging_dir/${slug}/SKILL.md"
verify_sha256 "${sha256}" "$staging_dir/${slug}/SKILL.md"
mkdir -p "$${target}/${slug}"
mv "$staging_dir/${slug}/SKILL.md" "$${target}/${slug}/SKILL.md"
${say(`  installed ${slug}`)}`,
    )
    .join("\n");

  return `verify_sha256() {
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

mkdir -p "$${target}"
${steps}`;
}
