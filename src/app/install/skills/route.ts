import {
  INSTALLABLE_SKILLS,
  skillDigests,
  skillInstallFragment,
} from "@/lib/agent-skills";
import { publicOrigin } from "@/lib/public-origin";

export async function GET() {
  const origin = publicOrigin();
  // Same digests the manifest publishes and the same install fragment
  // /connect embeds, so "the installer verified this" and "the manifest says
  // you are current" can never mean different bytes.
  const skillFiles = await skillDigests();
  const script = `#!/bin/sh
set -eu

target_dir="\${OPERATE_SKILLS_DIR:-.agents/skills}"
command -v curl >/dev/null 2>&1 || {
  echo "Operate skills installer requires curl." >&2
  exit 1
}

${skillInstallFragment(origin, skillFiles, { quiet: true })}

echo "Installed ${INSTALLABLE_SKILLS.length} Operate skills in $target_dir"
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
