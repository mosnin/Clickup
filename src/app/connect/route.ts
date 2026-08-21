import { skillDigests, skillInstallFragment } from "@/lib/agent-skills";
import { publicOrigin } from "@/lib/public-origin";

// GET /connect — the whole of onboarding, as one command.
//
//   curl -fsSL https://operate.to/connect | sh
//
// The agent runs this. The human clicks one link and approves. That is the
// entire flow, and it is the difference between onboarding that is agentic
// and onboarding an agent has to be walked through.
//
// The order below is not the obvious one, and each step is placed where it
// is for a reason:
//
//   1. Ask for the device code FIRST, so the link is on screen in about a
//      second. It is the only thing the human is waiting for.
//   2. Print the link, with the typed-code path beside it.
//   3. Install the skills WHILE they sign in. That window is otherwise dead
//      time and it is almost exactly long enough.
//   4. Poll, honouring the advertised interval and slow_down.
//   5. Write the credential where we said we would; PRINT the MCP config.
//
// Step 5 is a deliberate refusal to be clever. This script cannot know where
// an arbitrary runtime keeps its MCP config, and a wrong guess silently
// clobbers a file somebody depends on. It writes the credential to a known
// path and prints the block; the agent — which knows its own runtime — wires
// it up. OPERATE_MCP_CONFIG opts into writing a path for people who want it.
//
// POSIX sh, no jq, no bash-isms: `curl` and a SHA-256 binary are the whole
// dependency list, the same bar /install/skills already meets.

function script(origin: string, skills: { slug: string; sha256: string }[]) {
  return `#!/bin/sh
set -eu

# operate.to — connect this agent.
#
# Run:  curl -fsSL ${origin}/connect | sh
#
# Environment:
#   OPERATE_CLIENT       what to call this runtime on the consent screen
#   OPERATE_SKILLS_DIR   where to install skills (default .agents/skills)
#   OPERATE_HOME         where to write credentials (default .operate)
#   OPERATE_MCP_CONFIG   if set, also write the MCP config to this path
#   OPERATE_NO_SKILLS    set to 1 to skip skill installation

client="\${OPERATE_CLIENT:-unknown-agent}"
target_dir="\${OPERATE_SKILLS_DIR:-.agents/skills}"
home_dir="\${OPERATE_HOME:-.operate}"

command -v curl >/dev/null 2>&1 || {
  echo "operate: this installer requires curl." >&2
  exit 1
}

# Flat-JSON field readers. The responses this talks to are small, flat and
# machine-generated, so a dependency on jq would cost more than it buys —
# jq is absent from most slim images and this has to run in one.
json_str() {
  tr -d '\\n' | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p'
}
json_num() {
  tr -d '\\n' | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p'
}

# ── 1. Ask for a device code ────────────────────────────────────────────

device_response="$(curl -fsSL -X POST "${origin}/oauth/device" \\
  -H "Content-Type: application/json" \\
  -d "{\\"client_name\\":\\"$client\\"}" 2>/dev/null || true)"

device_code="$(printf '%s' "$device_response" | json_str device_code)"
user_code="$(printf '%s' "$device_response" | json_str user_code)"
verify_url="$(printf '%s' "$device_response" | json_str verification_uri_complete)"
verify_plain="$(printf '%s' "$device_response" | json_str verification_uri)"
interval="$(printf '%s' "$device_response" | json_num interval)"
expires_in="$(printf '%s' "$device_response" | json_num expires_in)"

if [ -z "$device_code" ] || [ -z "$user_code" ]; then
  echo "operate: could not start the connection." >&2
  echo "$device_response" >&2
  exit 1
fi
[ -n "$interval" ] || interval=5
[ -n "$expires_in" ] || expires_in=600

# ── 2. Hand the human the link ──────────────────────────────────────────
#
# Printed before anything slow happens, because this is the only thing
# anybody is waiting on. The typed-code path is offered beside it: following
# a link out of a terminal is a thing some people reasonably will not do,
# and the flow works either way.

echo ""
echo "  ┌──────────────────────────────────────────────────────────┐"
echo "  │  Connect this agent to operate.to                        │"
echo "  └──────────────────────────────────────────────────────────┘"
echo ""
echo "  Open:  $verify_url"
echo ""
echo "  Or go to $verify_plain and enter the code:  $user_code"
echo ""
echo "  You'll sign in (or sign up), choose what this agent may do,"
echo "  and approve. Nothing is connected until you do."
echo ""

# ── 3. Install skills while they sign in ────────────────────────────────

if [ "\${OPERATE_NO_SKILLS:-0}" != "1" ]; then
  echo "  Installing skills into $target_dir while you do that…"
${skillInstallFragment(origin, skills, { targetVar: "target_dir" })
  .split("\n")
  .map((line) => (line ? `  ${line}` : line))
  .join("\n")}
  echo ""
fi

# ── 4. Poll ─────────────────────────────────────────────────────────────

echo "  Waiting for approval…"
deadline="$(( $(date +%s) + expires_in ))"
api_key=""

while [ "$(date +%s)" -lt "$deadline" ]; do
  sleep "$interval"
  token_response="$(curl -fsSL -X POST "${origin}/oauth/token" \\
    -H "Content-Type: application/json" \\
    -d "{\\"grant_type\\":\\"urn:ietf:params:oauth:grant-type:device_code\\",\\"device_code\\":\\"$device_code\\"}" \\
    2>/dev/null || curl -sL -X POST "${origin}/oauth/token" \\
    -H "Content-Type: application/json" \\
    -d "{\\"grant_type\\":\\"urn:ietf:params:oauth:grant-type:device_code\\",\\"device_code\\":\\"$device_code\\"}" 2>/dev/null)"

  api_key="$(printf '%s' "$token_response" | json_str api_key)"
  [ -z "$api_key" ] && api_key="$(printf '%s' "$token_response" | json_str access_token)"
  [ -n "$api_key" ] && break

  err="$(printf '%s' "$token_response" | json_str error)"
  case "$err" in
    authorization_pending) ;;
    # Not advice: the server has already widened the interval it will accept.
    slow_down) interval="$(( interval + 5 ))" ;;
    access_denied)
      echo "operate: the request was declined." >&2
      exit 1 ;;
    expired_token)
      echo "operate: that code expired. Run this again to get a new one." >&2
      exit 1 ;;
    *)
      echo "operate: connection failed (\\\${err:-unknown})." >&2
      exit 1 ;;
  esac
done

if [ -z "$api_key" ]; then
  echo "operate: timed out waiting for approval. Run this again when ready." >&2
  exit 1
fi

# ── 5. Store the credential, print the config ───────────────────────────

agent_name="$(printf '%s' "$token_response" | json_str agent_name)"
scope_name="$(printf '%s' "$token_response" | json_str scope_name)"
mcp_url="$(printf '%s' "$token_response" | json_str mcp_url)"
key_expires_in="$(printf '%s' "$token_response" | json_num expires_in)"
[ -n "$mcp_url" ] || mcp_url="${origin}/api/mcp"
# Apex 308s POSTs. The token route should already emit www; do not store
# a URL that cannot be POSTed even if an older server sent apex.
case "$mcp_url" in
  https://operate.to/api/mcp*) mcp_url="https://www.operate.to/api/mcp" ;;
esac

mkdir -p "$home_dir"
# umask before the write, not chmod after: chmod leaves a window in which
# the key is readable, and on a shared machine that window is the whole bug.
old_umask="$(umask)"
umask 077
cat > "$home_dir/credentials.json" <<CREDS
{
  "api_key": "$api_key",
  "mcp_url": "$mcp_url",
  "agent_name": "$agent_name",
  "scope": "$scope_name",
  "expires_in": \${key_expires_in:-7776000}
}
CREDS
umask "$old_umask"

mcp_config="{
  \\"mcpServers\\": {
    \\"operate\\": {
      \\"url\\": \\"$mcp_url\\",
      \\"headers\\": { \\"Authorization\\": \\"Bearer $api_key\\" }
    }
  }
}"

if [ -n "\${OPERATE_MCP_CONFIG:-}" ]; then
  umask 077
  printf '%s\\n' "$mcp_config" > "$OPERATE_MCP_CONFIG"
  umask "$old_umask"
  echo "  Wrote MCP config to $OPERATE_MCP_CONFIG"
fi

echo ""
echo "  Connected as \\"$agent_name\\" in $scope_name."
echo "  Key stored in $home_dir/credentials.json (not printed above)."
if [ -n "$key_expires_in" ]; then
  echo "  Device-grant keys expire after \${key_expires_in}s. Re-run this flow before then."
fi
echo ""
echo "  Add this to your MCP config:"
echo ""
printf '%s\\n' "$mcp_config"
echo ""
echo "  Then call 'brief' first — it returns what this team has already"
echo "  decided, what is still open, and the limits you work under."
echo ""
`;
}

export async function GET() {
  const origin = publicOrigin();
  const skills = await skillDigests();
  return new Response(script(origin, skills), {
    headers: {
      "Content-Type": "text/x-shellscript; charset=utf-8",
      // Short: this script embeds skill digests, and a stale cached copy
      // would fail its own checksum verification after a skill changes.
      "Cache-Control": "public, max-age=60, s-maxage=60",
      "Content-Disposition": 'inline; filename="operate-connect.sh"',
    },
  });
}

export const dynamic = "force-dynamic";
