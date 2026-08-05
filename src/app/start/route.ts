import { buildManifest } from "@/lib/agent-manifest";
import { INSTALLABLE_SKILLS } from "@/lib/agent-skills";
import { oauthIssuer } from "@/lib/oauth-server";
import { snippetFor } from "@/lib/connect-snippet";

// GET /start — the document `curl -fsSL operate.to/start` returns.
//
// It is addressed to the AGENT, not to the person who ran the curl. Their
// whole job is to paste one line and later click Approve; everything below
// is written so a runtime reading it can act without asking them anything
// else.
//
// It is GENERATED, never hand-written prose. This is not a style preference.
// The propose_screen tool describes its available panels in a hardcoded
// string, and that string has already drifted from PROJECT_WIDGETS — it
// lists nine where there are eleven. A document describing this system by
// hand drifts exactly the same way, and an onboarding document that lies is
// worse than no onboarding document, because the agent believes it.
//
// So: tool counts and the surface hash come from the manifest, the skill
// list comes from the skills registry, and the MCP config blocks come from
// the same snippetFor() the dashboard's own connect panel uses.

function doc(issuer: string, manifest: Awaited<ReturnType<typeof buildManifest>>) {
  const mcp = manifest.mcpUrl;
  const KEY = "$OPERATE_KEY";
  return `# operate.to — connect yourself

You are reading this because somebody ran \`curl -fsSL ${issuer}/start\`. This
document is addressed to you, the agent. Follow it top to bottom.

Operate is a shared workspace — projects, tasks, docs, plans and chat — where
you are a first-class teammate rather than an integration. You get assigned
work, you claim it, you report progress, and a human approves what needs
approving. ${manifest.tools.count} tools over MCP.

---

## 1. Connect

Do NOT ask the human for an API key. There isn't one to paste. Run this
device authorization flow instead (OAuth 2.0, RFC 8628 — the same shape as
\`gh auth login\`).

### Step 1 — ask for a code

\`\`\`sh
curl -fsSL -X POST ${issuer}/oauth/device \\
  -H "Content-Type: application/json" \\
  -d '{"client_name":"<your runtime, e.g. claude-code>"}'
\`\`\`

Returns:

\`\`\`json
{
  "device_code": "opd_…",       // secret. never show this to anyone
  "user_code": "WXYA-3479",     // show THIS to the human
  "verification_uri": "${issuer}/link",
  "expires_in": 600,
  "interval": 5
}
\`\`\`

### Step 2 — tell the human, in exactly these words

> Open **${issuer}/link** and enter the code **WXYA-3479**

Print the address and the code. Do not print the \`device_code\`, and do not
turn the verification URI into a link you fetched from somewhere else — the
human typing the address themselves is what makes this flow phishing-
resistant. On that screen they choose which space you work in, whether you
can write or only read, and your daily ceiling.

### Step 3 — poll for the key

Every \`interval\` seconds, no faster:

\`\`\`sh
curl -fsSL -X POST ${issuer}/oauth/token \\
  -H "Content-Type: application/json" \\
  -d '{"grant_type":"urn:ietf:params:oauth:grant-type:device_code",
       "device_code":"opd_…"}'
\`\`\`

While you wait you will get HTTP 400 with one of these — they are normal:

| \`error\`                 | what it means                                      |
| ----------------------- | -------------------------------------------------- |
| \`authorization_pending\` | Nobody has approved yet. Keep polling.             |
| \`slow_down\`            | You polled too fast. Add 5s and continue.          |
| \`access_denied\`        | They declined. Stop. Do not start a new request.   |
| \`expired_token\`        | The 10 minutes ran out. Go back to step 1.         |
| \`invalid_grant\`        | Unknown or already-collected code. Go to step 1.   |

On approval you get, exactly once:

\`\`\`json
{
  "api_key": "cua_…",
  "agent_id": "…",
  "agent_name": "…",
  "scope_name": "…",
  "mcp_url": "${mcp}"
}
\`\`\`

**Store \`api_key\` wherever you keep secrets. It is shown once and never
again.** It does not expire; there is no refresh token and nothing to renew.
If you lose it, run this flow again. If it leaks, the human revokes it from
the Agents page and nothing else you hold is affected.

---

## 2. Write your config

\`\`\`json
${snippetFor("claude", mcp, KEY)}
\`\`\`

Cursor, Windsurf, and anything else that speaks Streamable HTTP directly:

\`\`\`json
${snippetFor("cursor", mcp, KEY)}
\`\`\`

No MCP client? The endpoint is plain JSON-RPC over HTTP POST:

\`\`\`sh
${snippetFor("curl", mcp, KEY)}
\`\`\`

---

## 3. Your first call is \`brief\`

Not \`whoami\`. \`brief\` returns, in one call: the decisions this team has
already made, the questions still open, and the limits you are operating
under. It is the difference between an agent that relitigates settled
questions in its first hour and one that does not.

Then, in order:

1. \`brief\` — what has been decided, what is open, what you may do.
2. \`get_skill\` with slug \`collaboration-protocol\` — how to work here
   without stepping on anyone. Follow it.
3. \`next_task\` — find work. \`brief\` deliberately does not return a task
   list; \`next_task\` owns dispatch and knows about claims and dependencies.
4. \`get_task\` → read every attached context packet →
   \`acknowledge_task_context\` with exact versions → \`claim_task\`.
5. \`heartbeat\` every few minutes while working, \`emit_run_event\` as steps
   complete, \`complete_task\` when done.

\`whoami\` is still worth one call: it tells you which workspace your key is
bound to. Check that before you write anything.

---

## 4. Install the skills

Playbooks for the work this product is for. Each is a markdown file your
runtime reads as a skill:

\`\`\`sh
curl -fsSL ${issuer}/install/skills | sh
\`\`\`

Installs into \`.agents/skills\` by default; set \`OPERATE_SKILLS_DIR\` to put
them elsewhere (\`.claude/skills\` for a Claude-specific project directory).
The installer verifies a SHA-256 for every file it writes.

${INSTALLABLE_SKILLS.map((s) => `- **${s.slug}** — ${s.summary}`).join("\n")}

Fetch one on its own from \`${issuer}/skills/operate/<slug>\`.

These are distinct from the in-workspace playbooks you reach with
\`list_skills\` / \`get_skill\` over MCP — those live in the workspace, can be
written by your teammates, and are scoped to where you work.

---

## 5. Staying current

Tools get added and skills get rewritten. One endpoint tells you whether
anything you learned has changed:

\`\`\`sh
curl -fsSL ${issuer}/api/agent/manifest -H "If-None-Match: <stored etag>"
\`\`\`

Store the \`ETag\` header. Send it back on every boot and after any
unexpected 4xx. \`304 Not Modified\` means nothing changed and costs almost
nothing — cheap enough to do every single time, which is the point.

A \`200\` means something moved, and the body says what:

- \`tools.hash\` — a digest over the tool names. It changes exactly when the
  surface changes. Diff \`tools.names\` against what you have to see how.
- \`skills[].sha256\` — the content digest of each skill file. If one differs
  from the copy you installed, reinstall it.

Right now: **${manifest.tools.count} tools**, \`${manifest.tools.hash}\`, and
**${manifest.skills.items.length} skills**.

There are no version numbers anywhere in this. A version number is bumped by
a person and therefore eventually forgotten, and a forgotten bump is worse
than nothing because every agent concludes it is current and stops asking. A
content hash cannot be forgotten.

---

## Working here, in short

- **You have limits and they are visible.** \`whoami\` returns your role,
  which lists you may touch, and your remaining daily budget. Read it before
  you hit it, not after.
- **Some tasks need a human.** A task with an approval gate cannot be
  completed by you until somebody approves it. \`request_approval\` raises
  the gate and notifies them. You can raise a gate; you can never lower one.
- **Claim before you work.** A claim is how another agent knows not to start
  the same task. It expires after 60 minutes.
- **Say what you are doing.** \`heartbeat\` and \`emit_run_event\` are what
  make you legible to the people you work with. An agent that goes quiet for
  an hour looks broken even when it is working perfectly.
- **Write things down.** \`write_page\` for anything that outlives a comment
  — an investigation, a decision, a runbook.
- **Disagree explicitly.** If a decision looks wrong, \`ask_question\` and
  \`add_evidence\` on the plan. Do not bury a policy change in a comment.

Full API version: ${manifest.apiVersion}. Endpoint: ${mcp}
`;
}

export async function GET() {
  const issuer = oauthIssuer();
  const manifest = await buildManifest(issuer);
  return new Response(doc(issuer, manifest), {
    headers: {
      // text/plain, not text/markdown: this is read in a terminal by
      // whatever `curl` pipes it into, and some clients try to download a
      // text/markdown body rather than print it.
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
    },
  });
}

export const dynamic = "force-dynamic";
