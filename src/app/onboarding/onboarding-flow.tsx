"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { ArrowRight, Check, Copy } from "lucide-react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  AnimatePresence,
  EASE,
  motion,
  MotionConfig,
} from "@/components/motion";

// First-run experience: two questions, then the product builds itself.
// One idea per screen, big editorial type, Enter to continue. Ends with
// the agent's API key presented once — the handshake that makes the
// whole product real — and drops the user into a living dashboard.

const AGENT_EMOJI = ["🤖", "🦾", "🛰️", "⚡", "🔭", "🧠"];

type BuildState =
  | { phase: "building"; step: number }
  | { phase: "done"; key: string; workspaceId: string }
  | { phase: "error"; message: string };

const BUILD_STEPS = [
  "Creating your workspace",
  "Raising HQ",
  "Writing your first tasks",
  "Waking your agent",
];

export function OnboardingFlow({ firstName }: { firstName: string }) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [workspaceName, setWorkspaceName] = useState("");
  const [agentName, setAgentName] = useState("Scout");
  const [agentEmoji, setAgentEmoji] = useState("🤖");

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex min-h-dvh flex-col bg-page p-4">
        <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col">
          {/* Wordmark + skip */}
          <div className="flex items-center justify-between py-6">
            <div className="flex items-center gap-2.5">
              <span
                aria-hidden
                className="inline-block h-3.5 w-3.5 rounded-[4px] bg-foreground"
              />
              <span className="text-[13px] font-extrabold uppercase tracking-[0.22em]">
                ClickUp&nbsp;Clone
              </span>
            </div>
            {step < 2 && (
              <button
                type="button"
                onClick={() => router.push("/dashboard")}
                className="text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                Set up later
              </button>
            )}
          </div>

          {/* Progress dots */}
          <div className="flex items-center gap-1.5 pb-10">
            {[0, 1, 2].map((i) => (
              <motion.span
                key={i}
                className="h-1.5 rounded-full bg-foreground"
                animate={{
                  width: step === i ? 24 : 6,
                  opacity: step >= i ? 1 : 0.2,
                }}
                transition={{ duration: 0.4, ease: EASE }}
              />
            ))}
          </div>

          <div className="flex flex-1 flex-col justify-start">
            <AnimatePresence mode="wait">
              {step === 0 && (
                <Screen key="s0">
                  <StepWorkspace
                    firstName={firstName}
                    value={workspaceName}
                    onChange={setWorkspaceName}
                    onNext={() => setStep(1)}
                  />
                </Screen>
              )}
              {step === 1 && (
                <Screen key="s1">
                  <StepAgent
                    name={agentName}
                    emoji={agentEmoji}
                    onName={setAgentName}
                    onEmoji={setAgentEmoji}
                    onNext={() => setStep(2)}
                  />
                </Screen>
              )}
              {step === 2 && (
                <Screen key="s2">
                  <StepBuild
                    workspaceName={workspaceName}
                    agentName={agentName}
                    agentEmoji={agentEmoji}
                    onRetry={() => setStep(1)}
                  />
                </Screen>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </MotionConfig>
  );
}

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: 28, filter: "blur(4px)" }}
      animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
      exit={{ opacity: 0, x: -28, filter: "blur(4px)" }}
      transition={{ duration: 0.45, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

// Big borderless input — the question IS the interface.
function HeroInput({
  value,
  onChange,
  placeholder,
  onEnter,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  onEnter: () => void;
}) {
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && value.trim()) onEnter();
      }}
      placeholder={placeholder}
      maxLength={48}
      className="w-full border-b-2 border-border bg-transparent pb-3 text-3xl font-bold tracking-tight placeholder:text-muted-foreground/40 focus:border-foreground focus:outline-none sm:text-4xl"
    />
  );
}

function StepWorkspace({
  firstName,
  value,
  onChange,
  onNext,
}: {
  firstName: string;
  value: string;
  onChange: (v: string) => void;
  onNext: () => void;
}) {
  return (
    <div>
      <p className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
        Welcome, {firstName}
      </p>
      <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">
        Where will the work live?
      </h1>
      <p className="mt-3 max-w-md text-muted-foreground">
        Your workspace is home for every task, doc, and agent. Name it after
        your team or company.
      </p>
      <div className="mt-10">
        <HeroInput
          value={value}
          onChange={onChange}
          placeholder="Acme Inc."
          onEnter={onNext}
        />
      </div>
      <div className="mt-8 flex items-center gap-3">
        <Button size="lg" disabled={!value.trim()} onClick={onNext}>
          Continue <ArrowRight className="h-4 w-4" />
        </Button>
        <span className="text-xs text-muted-foreground">press Enter ↵</span>
      </div>
    </div>
  );
}

function StepAgent({
  name,
  emoji,
  onName,
  onEmoji,
  onNext,
}: {
  name: string;
  emoji: string;
  onName: (v: string) => void;
  onEmoji: (v: string) => void;
  onNext: () => void;
}) {
  return (
    <div>
      <p className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
        Step two
      </p>
      <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">
        Meet your first agent.
      </h1>
      <p className="mt-3 max-w-md text-muted-foreground">
        It lives here — its brain runs wherever you run agents. You&apos;ll
        assign it work, watch it live, and approve what ships.
      </p>

      <div className="mt-10 flex items-center gap-2">
        {AGENT_EMOJI.map((e) => (
          <motion.button
            key={e}
            type="button"
            onClick={() => onEmoji(e)}
            whileTap={{ scale: 0.9 }}
            animate={{ scale: emoji === e ? 1.1 : 1 }}
            transition={{ type: "spring", stiffness: 400, damping: 20 }}
            className={cn(
              "inline-flex h-12 w-12 items-center justify-center rounded-full border text-2xl transition-colors",
              emoji === e
                ? "border-foreground bg-foreground/5"
                : "border-border hover:border-foreground/25",
            )}
            aria-pressed={emoji === e}
          >
            {e}
          </motion.button>
        ))}
      </div>

      <div className="mt-6">
        <HeroInput
          value={name}
          onChange={onName}
          placeholder="Scout"
          onEnter={onNext}
        />
      </div>

      <div className="mt-8 flex items-center gap-3">
        <Button size="lg" disabled={!name.trim()} onClick={onNext}>
          Bring {name.trim() || "it"} online <ArrowRight className="h-4 w-4" />
        </Button>
        <span className="text-xs text-muted-foreground">press Enter ↵</span>
      </div>
    </div>
  );
}

function StepBuild({
  workspaceName,
  agentName,
  agentEmoji,
  onRetry,
}: {
  workspaceName: string;
  agentName: string;
  agentEmoji: string;
  onRetry: () => void;
}) {
  const router = useRouter();
  const completeSetup = useMutation(api.onboarding.completeSetup);
  const createKey = useAction(api.agentKeys.createKey);
  const [state, setState] = useState<BuildState>({
    phase: "building",
    step: 0,
  });
  const [copied, setCopied] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    // Advance the build narration while the real work happens.
    const timers = BUILD_STEPS.map((_, i) =>
      setTimeout(
        () =>
          setState((s) =>
            s.phase === "building" ? { phase: "building", step: i + 1 } : s,
          ),
        450 * (i + 1),
      ),
    );

    (async () => {
      try {
        const result = await completeSetup({
          workspaceName,
          agentName,
          agentEmoji,
        });
        const { key } = await createKey({ agentId: result.agentId });
        // Let the narration finish its beat before the reveal.
        setTimeout(
          () =>
            setState({ phase: "done", key, workspaceId: result.workspaceId }),
          Math.max(0, 450 * (BUILD_STEPS.length + 1)),
        );
      } catch (err) {
        setState({
          phase: "error",
          message: err instanceof Error ? err.message : "Setup failed",
        });
      }
      return () => timers.forEach(clearTimeout);
    })();
  }, [agentEmoji, agentName, completeSetup, createKey, workspaceName]);

  if (state.phase === "error") {
    return (
      <div>
        <h1 className="text-3xl font-bold tracking-tight">
          Something went wrong.
        </h1>
        <p className="mt-2 text-sm text-red-600">{state.message}</p>
        <Button className="mt-6" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
        {state.phase === "done"
          ? `${agentEmoji} ${agentName} is ready.`
          : "Building your mission control…"}
      </h1>

      <ul className="mt-8 space-y-3">
        {BUILD_STEPS.map((label, i) => {
          const reached =
            state.phase === "done" ||
            (state.phase === "building" && state.step > i);
          return (
            <motion.li
              key={label}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: reached ? 1 : 0.3, y: 0 }}
              transition={{ duration: 0.4, ease: EASE, delay: i * 0.08 }}
              className="flex items-center gap-3 text-sm"
            >
              <motion.span
                initial={false}
                animate={{
                  backgroundColor: reached ? "#101012" : "#ececee",
                  scale: reached ? 1 : 0.8,
                }}
                transition={{ type: "spring", stiffness: 300, damping: 20 }}
                className="inline-flex h-5 w-5 items-center justify-center rounded-full"
              >
                {reached && <Check className="h-3 w-3 text-white" />}
              </motion.span>
              <span className={reached ? "" : "text-muted-foreground"}>
                {label}
              </span>
            </motion.li>
          );
        })}
      </ul>

      <AnimatePresence>
        {state.phase === "done" && (
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.5, ease: EASE }}
            className="mt-10"
          >
            <div className="rounded-2xl border border-border bg-background p-5 shadow-sm">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {agentName}&apos;s API key — shown once
              </p>
              <div className="mt-2 flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-lg bg-muted px-3 py-2 text-sm">
                  {state.key}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    await navigator.clipboard.writeText(state.key);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Point any MCP-capable runtime at{" "}
                <code className="rounded bg-muted px-1 py-0.5">
                  /api/mcp
                </code>{" "}
                with{" "}
                <code className="rounded bg-muted px-1 py-0.5">
                  Authorization: Bearer &lt;this key&gt;
                </code>
                . Your &quot;Getting started&quot; list walks you through the
                rest — {agentName} already has work waiting.
              </p>
            </div>

            <Button
              size="lg"
              className="mt-6"
              onClick={() => router.push("/dashboard?welcome=1")}
            >
              Enter mission control <ArrowRight className="h-4 w-4" />
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
