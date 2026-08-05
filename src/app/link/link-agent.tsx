"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useConvexAuth, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";

// The consent screen for the device flow.
//
// It asks three questions, one per screen, because the point of doing this
// at approval time rather than afterwards is that somebody actually reads
// it. A single page carrying a code field, a scope picker, an agent picker,
// a role toggle and a budget is a page people click through.
//
// The questions are ordered by how much they narrow: where it works, then
// who it is, then what it may do. That is also the order in which an answer
// makes the next question smaller.

type Step = "code" | "where" | "what" | "done";

// What lookupUserCode returns. Declared here rather than inferred because
// the generated Convex types are a stub until `convex dev` runs, and the
// screen branches on `state` for every one of its five outcomes.
type LookupResult =
  | { state: "not_found" | "expired" | "denied" | "approved" | "claimed" }
  | {
      state: "pending";
      clientName: string;
      expiresAt: number;
      scopes: {
        parentType: "user" | "workspace";
        parentId: string;
        name: string;
        canManage: boolean;
      }[];
      agents: {
        agentId: Id<"agents">;
        name: string;
        scopeId: string;
        role: "member" | "readonly";
        lastSeenAt: number | null;
      }[];
    };

// The budgets people actually mean, rather than a number field. The daily
// limit exists to bound a runaway loop, and nobody has a considered opinion
// about 1500 vs 2000 — they have an opinion about "trial" vs "let it work".
const BUDGETS = [
  { label: "Trying it out", value: 200, hint: "200 changes a day" },
  { label: "Normal use", value: 2000, hint: "2,000 changes a day" },
  { label: "Heavy automation", value: 20000, hint: "20,000 changes a day" },
] as const;

export function LinkAgent({ initialCode }: { initialCode: string }) {
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const [code, setCode] = useState(initialCode);
  const [submitted, setSubmitted] = useState("");
  const [step, setStep] = useState<Step>("code");

  // A mutation, not a query, because a lookup that must be rate-limited is a
  // write — see convex/agentAuth.ts for why an unthrottled version of this
  // is an agent-hijack oracle. So the result is held in state and fetched
  // once, rather than being a live subscription.
  const lookup = useMutation(api.agentAuth.lookupUserCode);
  const approve = useMutation(api.agentAuth.approveDeviceRequest);
  const deny = useMutation(api.agentAuth.denyDeviceRequest);
  const [request, setRequest] = useState<LookupResult | undefined>(undefined);
  const [lookupError, setLookupError] = useState<string | null>(null);

  // Guards the auto-submit below against React 18 double-effects and against
  // re-running when auth resolves: each spends a rate-limit attempt on a
  // miss, and a page that quietly burns somebody's budget on mount is how a
  // legitimate user gets locked out of their own connection.
  const requested = useRef("");

  const runLookup = useCallback(
    async (value: string) => {
      const clean = value.trim();
      if (!clean || requested.current === clean) return;
      requested.current = clean;
      setSubmitted(clean);
      setRequest(undefined);
      setLookupError(null);
      try {
        setRequest((await lookup({ userCode: clean })) as LookupResult);
      } catch (cause) {
        setLookupError(errorMessage(cause, "Could not look up that code"));
      }
    },
    [lookup],
  );

  // A code in the URL (RFC 8628's verification_uri_complete) skips the
  // typing, not the consent: it lands on "where should it work", never on an
  // approval. A link that self-approves is a pasted key with extra steps.
  useEffect(() => {
    if (!isAuthenticated || !initialCode) return;
    void runLookup(initialCode);
    setStep("where");
  }, [isAuthenticated, initialCode, runLookup]);

  const [scopeId, setScopeId] = useState("");
  const [agentChoice, setAgentChoice] = useState<Id<"agents"> | "new">("new");
  const [agentName, setAgentName] = useState("");
  const [role, setRole] = useState<"member" | "readonly">("member");
  const [budget, setBudget] = useState<number>(2000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ name: string; created: boolean } | null>(
    null,
  );

  const pending = request?.state === "pending" ? request : null;
  const scopes = useMemo(() => pending?.scopes ?? [], [pending]);

  // Default to the only scope the human can actually manage when there is
  // exactly one; otherwise make them say. Personal space is always present,
  // so "manageable scopes" is never empty.
  useEffect(() => {
    if (!pending || scopeId) return;
    const usable = scopes.filter((scope) => scope.canManage);
    if (usable.length > 0) setScopeId(usable[0].parentId);
    setAgentName(pending.clientName);
  }, [pending, scopes, scopeId]);

  const scope = scopes.find((entry) => entry.parentId === scopeId) ?? null;
  const agentsHere = (pending?.agents ?? []).filter(
    (agent) => agent.scopeId === scopeId,
  );

  const submitCode = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    void runLookup(code);
    setStep("where");
  };

  const retryWithAnotherCode = () => {
    // Clear the guard as well as the field, or the same code cannot be
    // retried after a transient failure.
    requested.current = "";
    setSubmitted("");
    setCode("");
    setRequest(undefined);
    setLookupError(null);
    setStep("code");
  };

  const finish = async () => {
    if (!scope) return;
    setBusy(true);
    setError(null);
    try {
      const chosen =
        agentChoice === "new"
          ? {
              parentType: scope.parentType,
              parentId: scope.parentId,
              agentName: agentName.trim() || pending!.clientName,
            }
          : { agentId: agentChoice };
      const outcome = (await approve({
        userCode: submitted,
        ...chosen,
        role,
        dailyActionLimit: budget,
      })) as { approved: boolean };
      // A bad code comes back as a value rather than an exception, because
      // the rate-limit counter behind it has to survive the call.
      if (!outcome.approved) {
        setError(
          "That code is no longer valid. Ask your agent for a new one.",
        );
        return;
      }
      setResult({
        name:
          agentChoice === "new"
            ? agentName.trim() || pending!.clientName
            : (agentsHere.find((a) => a.agentId === agentChoice)?.name ??
              "your agent"),
        created: agentChoice === "new",
      });
      setStep("done");
    } catch (cause) {
      setError(errorMessage(cause, "Could not approve this request"));
    } finally {
      setBusy(false);
    }
  };

  const decline = async () => {
    setBusy(true);
    try {
      await deny({ userCode: submitted });
    } catch {
      // Declining is best-effort: the code expires on its own in minutes,
      // so a failure here costs nothing and a red banner would only confuse.
    }
    setBusy(false);
    retryWithAnotherCode();
  };

  if (authLoading || !isAuthenticated) {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">Checking your session…</p>
      </Shell>
    );
  }

  // ── Step 1: the code ────────────────────────────────────────────────
  if (step === "code" || !submitted) {
    return (
      <Shell>
        <Eyebrow>Connect an agent</Eyebrow>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          Enter the code your agent showed you
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Your agent printed an eight-character code when it started
          connecting. It expires ten minutes after that.
        </p>
        <form onSubmit={submitCode}>
          <input
            autoFocus
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            placeholder="XXXX-XXXX"
            aria-label="Device code"
            className="soft-field mt-6 h-16 w-full text-center font-mono text-2xl tracking-[0.35em] uppercase"
          />
          <Button type="submit" className="mt-4 w-full" disabled={!code.trim()}>
            Continue
          </Button>
        </form>
        <Footnote />
      </Shell>
    );
  }

  // A thrown lookup is a different thing from a code that came back
  // unrecognised, and the one that actually happens is the rate limit — so
  // it says what it is rather than blaming the code.
  if (lookupError) {
    return (
      <Shell>
        <Eyebrow>Connect an agent</Eyebrow>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          That didn&apos;t work
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {lookupError}
        </p>
        <Button
          variant="outline"
          className="mt-6 w-full"
          onClick={retryWithAnotherCode}
        >
          Try again
        </Button>
      </Shell>
    );
  }

  if (request === undefined) {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">Looking up that code…</p>
      </Shell>
    );
  }

  if (request.state !== "pending") {
    const reason =
      request.state === "expired"
        ? "That code has expired. Ask your agent to start again — it takes a second."
        : request.state === "claimed" || request.state === "approved"
          ? "That code was already used. If your agent is still waiting, have it request a new one."
          : request.state === "denied"
            ? "That request was declined."
            : "We don't recognise that code. Check for a typo, or ask your agent for a new one.";
    return (
      <Shell>
        <Eyebrow>Connect an agent</Eyebrow>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          That didn&apos;t work
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{reason}</p>
        <Button
          variant="outline"
          className="mt-6 w-full"
          onClick={retryWithAnotherCode}
        >
          Try another code
        </Button>
      </Shell>
    );
  }

  // ── Step 3: connected ───────────────────────────────────────────────
  if (step === "done" && result) {
    return (
      <Shell>
        <Eyebrow>Connected</Eyebrow>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          {result.name} is connected
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Your agent is collecting its key now — you can close this tab. It
          never appeared on this screen, so there is nothing here to copy.
        </p>
        <div className="mt-6 flex gap-3">
          <Link href="/dashboard/agents" className="flex-1">
            <Button className="w-full">See it in Mission Control</Button>
          </Link>
        </div>
        <p className="mt-5 text-xs leading-5 text-muted-foreground">
          Change its permissions or cut it off at any time from the Agents
          page. Pausing an agent revokes its access immediately.
        </p>
      </Shell>
    );
  }

  // ── Step 2a: where it works ─────────────────────────────────────────
  if (step === "where") {
    const usable = scopes.filter((entry) => entry.canManage);
    return (
      <Shell>
        <Eyebrow>{pending!.clientName} wants to connect</Eyebrow>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          Where should it work?
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          An agent belongs to one space and cannot reach outside it. This is
          the boundary — everything else is a narrowing of it.
        </p>
        <div className="mt-6 space-y-2">
          {usable.map((entry) => (
            <Choice
              key={entry.parentId}
              selected={scopeId === entry.parentId}
              onSelect={() => {
                setScopeId(entry.parentId);
                setAgentChoice("new");
              }}
              title={entry.name}
              hint={
                entry.parentType === "user"
                  ? "Private to you"
                  : "Shared with this workspace's members"
              }
            />
          ))}
        </div>
        {scopeId && agentsHere.length > 0 && (
          <>
            <p className="mt-7 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Connect as
            </p>
            <div className="mt-2 space-y-2">
              <Choice
                selected={agentChoice === "new"}
                onSelect={() => setAgentChoice("new")}
                title="A new agent"
                hint="Starts with no history and the permissions you set next"
              />
              {agentsHere.map((agent) => (
                <Choice
                  key={agent.agentId}
                  selected={agentChoice === agent.agentId}
                  onSelect={() => setAgentChoice(agent.agentId)}
                  title={agent.name}
                  hint={
                    agent.lastSeenAt
                      ? "Already exists — keeps its work and history"
                      : "Already exists — never connected"
                  }
                />
              ))}
            </div>
          </>
        )}
        {agentChoice === "new" && scopeId && (
          <>
            <label
              className="mt-7 block text-xs font-semibold uppercase tracking-wider text-muted-foreground"
              htmlFor="link-agent-name"
            >
              Call it
            </label>
            <input
              id="link-agent-name"
              value={agentName}
              onChange={(event) => setAgentName(event.target.value)}
              placeholder={pending!.clientName}
              className="soft-field mt-2 h-11 w-full px-3 text-sm"
            />
          </>
        )}
        <div className="mt-7 flex gap-3">
          <Button
            className="flex-1"
            disabled={!scopeId}
            onClick={() => setStep("what")}
          >
            Continue
          </Button>
          <Button variant="outline" onClick={decline} disabled={busy}>
            Decline
          </Button>
        </div>
      </Shell>
    );
  }

  // ── Step 2b: what it may do ─────────────────────────────────────────
  return (
    <Shell>
      <Eyebrow>{pending!.clientName} wants to connect</Eyebrow>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        What may it do?
      </h1>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        In {scope?.name ?? "this space"}. You can change any of this later,
        and pausing the agent cuts it off immediately.
      </p>
      <div className="mt-6 space-y-2">
        <Choice
          selected={role === "member"}
          onSelect={() => setRole("member")}
          title="Work like a teammate"
          hint="Read and change tasks, docs and comments. Approval gates and budgets still apply."
        />
        <Choice
          selected={role === "readonly"}
          onSelect={() => setRole("readonly")}
          title="Read only"
          hint="Can see everything in this space and change nothing."
        />
      </div>
      <p className="mt-7 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Daily ceiling
      </p>
      <div className="mt-2 space-y-2">
        {BUDGETS.map((option) => (
          <Choice
            key={option.value}
            selected={budget === option.value}
            onSelect={() => setBudget(option.value)}
            title={option.label}
            hint={`Stops at ${option.hint} — a runaway loop cannot outrun this`}
          />
        ))}
      </div>
      {error && (
        <p className="mt-5 rounded-xl bg-pastel-red px-3 py-2 text-sm text-neutral-900">
          {error}
        </p>
      )}
      <div className="mt-7 flex gap-3">
        <Button className="flex-1" onClick={finish} disabled={busy}>
          {busy ? "Connecting…" : "Approve"}
        </Button>
        <Button
          variant="outline"
          onClick={() => setStep("where")}
          disabled={busy}
        >
          Back
        </Button>
      </div>
      <Footnote />
    </Shell>
  );
}

function Choice({
  selected,
  onSelect,
  title,
  hint,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`lift block w-full rounded-2xl px-4 py-3 text-left transition ${
        selected
          ? "bento bg-card ring-2 ring-foreground"
          : "bento-tile hover:bg-muted/60"
      }`}
    >
      <span className="block text-sm font-medium">{title}</span>
      <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
        {hint}
      </span>
    </button>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </p>
  );
}

function Footnote() {
  return (
    <p className="mt-6 text-xs leading-5 text-muted-foreground">
      Your agent&apos;s key is delivered straight to it and never shown here,
      so it cannot end up in a chat log or a committed file.
    </p>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-page p-5">
      <div className="bento w-full max-w-lg rounded-3xl bg-card p-6 sm:p-8">
        <Link href="/" aria-label="Operate home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/operate-logo-black.svg"
            alt="operate.to"
            className="h-6 w-auto dark:invert"
          />
        </Link>
        <div className="mt-8">{children}</div>
      </div>
    </main>
  );
}
