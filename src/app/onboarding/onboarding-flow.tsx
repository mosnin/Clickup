"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  AnimatePresence,
  EASE,
  motion,
  MotionConfig,
  PresenceDot,
  SPRING,
} from "@/components/motion";

// First-run experience — a cinematic, Apple-caliber setup. A welcome
// ceremony, two questions each with a live preview that assembles as you
// type, a build sequence where your mission control comes alive, and the
// agent's first key presented once. Deliberately icon-free: everything is
// carried by type, motion, gradient, and presence.

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
  // -1 = welcome ceremony; 0/1/2 = the three real steps.
  const [step, setStep] = useState(-1);
  const [workspaceName, setWorkspaceName] = useState("");
  const [agentName, setAgentName] = useState("Scout");
  const [agentEmoji, setAgentEmoji] = useState("🤖");

  return (
    <MotionConfig reducedMotion="user">
      <div className="relative flex min-h-dvh flex-col overflow-hidden bg-[linear-gradient(180deg,#fbfbfc_0%,#f2f2f5_100%)]">
        <Aurora />

        <div className="relative z-10 mx-auto flex w-full max-w-5xl flex-1 flex-col px-5 sm:px-8">
          {/* Wordmark + skip */}
          <div className="flex items-center justify-between py-6">
            <div className="flex items-center gap-2.5">
              <span
                aria-hidden
                className="inline-block h-3.5 w-3.5 rounded-[4px] bg-foreground"
              />
              <span className="text-[13px] font-extrabold uppercase tracking-[0.22em]">
                operate.to
              </span>
            </div>
            {step >= 0 && step < 2 && (
              <button
                type="button"
                onClick={() => router.push("/dashboard")}
                className="text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                Set up later
              </button>
            )}
          </div>

          {step >= 0 && <Progress step={step} />}

          <div className="flex flex-1 flex-col justify-center pb-16">
            <AnimatePresence mode="wait">
              {step === -1 && (
                <Screen key="welcome" center>
                  <WelcomeStep
                    firstName={firstName}
                    onStart={() => setStep(0)}
                  />
                </Screen>
              )}

              {step === 0 && (
                <Screen key="s0">
                  <SplitStep
                    preview={
                      <LivePreview
                        workspaceName={workspaceName}
                        agentName={agentName}
                        agentEmoji={agentEmoji}
                        stage="workspace"
                      />
                    }
                  >
                    <WorkspaceStep
                      value={workspaceName}
                      onChange={setWorkspaceName}
                      onNext={() => setStep(1)}
                    />
                  </SplitStep>
                </Screen>
              )}

              {step === 1 && (
                <Screen key="s1">
                  <SplitStep
                    preview={
                      <LivePreview
                        workspaceName={workspaceName}
                        agentName={agentName}
                        agentEmoji={agentEmoji}
                        stage="agent"
                      />
                    }
                  >
                    <AgentStep
                      name={agentName}
                      emoji={agentEmoji}
                      onName={setAgentName}
                      onEmoji={setAgentEmoji}
                      onNext={() => setStep(2)}
                    />
                  </SplitStep>
                </Screen>
              )}

              {step === 2 && (
                <Screen key="s2">
                  <BuildStep
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

// Soft drifting aurora behind the whole flow — depth without decoration.
function Aurora() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      <motion.span
        className="absolute -left-32 -top-24 h-[32rem] w-[32rem] rounded-full blur-3xl"
        style={{
          background:
            "radial-gradient(closest-side, var(--color-pastel-blue), transparent 70%)",
          opacity: 0.5,
        }}
        animate={{ x: [0, 40, 0], y: [0, 30, 0], scale: [1, 1.08, 1] }}
        transition={{ duration: 22, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.span
        className="absolute -right-24 top-1/3 h-[28rem] w-[28rem] rounded-full blur-3xl"
        style={{
          background:
            "radial-gradient(closest-side, var(--color-pastel-purple), transparent 70%)",
          opacity: 0.45,
        }}
        animate={{ x: [0, -30, 0], y: [0, 40, 0], scale: [1, 1.1, 1] }}
        transition={{ duration: 28, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.span
        className="absolute -bottom-32 left-1/3 h-[26rem] w-[26rem] rounded-full blur-3xl"
        style={{
          background:
            "radial-gradient(closest-side, var(--color-pastel-pink), transparent 70%)",
          opacity: 0.4,
        }}
        animate={{ x: [0, 30, 0], y: [0, -20, 0], scale: [1, 1.06, 1] }}
        transition={{ duration: 25, repeat: Infinity, ease: "easeInOut" }}
      />
    </div>
  );
}

function Progress({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-2 pb-12">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-1 flex-1 overflow-hidden rounded-full bg-foreground/10"
        >
          <motion.span
            className="block h-full rounded-full bg-foreground"
            initial={false}
            animate={{ width: step > i ? "100%" : step === i ? "50%" : "0%" }}
            transition={{ duration: 0.5, ease: EASE }}
          />
        </div>
      ))}
    </div>
  );
}

function Screen({
  children,
  center,
}: {
  children: React.ReactNode;
  center?: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24, filter: "blur(6px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      exit={{ opacity: 0, y: -24, filter: "blur(6px)" }}
      transition={{ duration: 0.5, ease: EASE }}
      className={cn(center && "text-center")}
    >
      {children}
    </motion.div>
  );
}

// Two-column layout: the question on the left, the live preview on the right
// (stacks on mobile, preview first so you always see it forming).
function SplitStep({
  children,
  preview,
}: {
  children: React.ReactNode;
  preview: React.ReactNode;
}) {
  return (
    <div className="grid items-center gap-10 lg:grid-cols-[1fr_22rem]">
      <div className="order-2 lg:order-1">{children}</div>
      <div className="order-1 lg:order-2">{preview}</div>
    </div>
  );
}

function WelcomeStep({
  firstName,
  onStart,
}: {
  firstName: string;
  onStart: () => void;
}) {
  return (
    <div className="mx-auto max-w-2xl">
      <motion.p
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1, duration: 0.6, ease: EASE }}
        className="text-sm font-medium uppercase tracking-[0.2em] text-muted-foreground"
      >
        Welcome
      </motion.p>
      <motion.h1
        initial={{ opacity: 0, y: 18, filter: "blur(8px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        transition={{ delay: 0.25, duration: 0.8, ease: EASE }}
        className="mt-4 text-5xl font-bold tracking-[-0.03em] sm:text-7xl"
      >
        Hello, {firstName}.
      </motion.h1>
      <motion.p
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.55, duration: 0.6, ease: EASE }}
        className="mx-auto mt-6 max-w-md text-lg leading-relaxed text-muted-foreground"
      >
        In two answers you&apos;ll have a workspace, a home for your team, and
        your first AI agent — online and already holding a task.
      </motion.p>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.85, duration: 0.6, ease: EASE }}
        className="mt-10"
      >
        <Button size="lg" onClick={onStart}>
          Begin
        </Button>
      </motion.div>
    </div>
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

function WorkspaceStep({
  value,
  onChange,
  onNext,
}: {
  value: string;
  onChange: (v: string) => void;
  onNext: () => void;
}) {
  return (
    <div>
      <p className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
        First
      </p>
      <h1 className="mt-3 text-4xl font-bold tracking-[-0.02em] sm:text-5xl">
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
      <div className="mt-8 flex items-center gap-4">
        <Button size="lg" disabled={!value.trim()} onClick={onNext}>
          Continue
        </Button>
        <span className="text-xs text-muted-foreground">press Enter ↵</span>
      </div>
    </div>
  );
}

function AgentStep({
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
        Now
      </p>
      <h1 className="mt-3 text-4xl font-bold tracking-[-0.02em] sm:text-5xl">
        Meet your first agent.
      </h1>
      <p className="mt-3 max-w-md text-muted-foreground">
        It lives here — its brain runs wherever you run agents. You&apos;ll
        assign it work, watch it live, and approve what ships.
      </p>

      <div className="mt-8 flex items-center gap-2">
        {AGENT_EMOJI.map((e) => (
          <motion.button
            key={e}
            type="button"
            onClick={() => onEmoji(e)}
            whileTap={{ scale: 0.9 }}
            animate={{ scale: emoji === e ? 1.12 : 1 }}
            transition={SPRING}
            className={cn(
              "inline-flex h-12 w-12 items-center justify-center rounded-full border text-2xl transition-colors",
              emoji === e
                ? "border-foreground bg-foreground/5"
                : "border-border hover:border-foreground/25",
            )}
            aria-pressed={emoji === e}
            aria-label={`Agent avatar ${e}`}
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

      <div className="mt-8 flex items-center gap-4">
        <Button size="lg" disabled={!name.trim()} onClick={onNext}>
          Bring {name.trim() || "it"} online
        </Button>
        <span className="text-xs text-muted-foreground">press Enter ↵</span>
      </div>
    </div>
  );
}

// The floating "mission control" preview that assembles as the user answers.
function LivePreview({
  workspaceName,
  agentName,
  agentEmoji,
  stage,
}: {
  workspaceName: string;
  agentName: string;
  agentEmoji: string;
  stage: "workspace" | "agent" | "live";
}) {
  const ws = workspaceName.trim() || "Your workspace";
  const agentReady = stage === "agent" || stage === "live";
  return (
    <motion.div
      layout
      className="mx-auto w-full max-w-sm rounded-[1.5rem] bg-white p-5 shadow-[0_1px_2px_rgb(16_16_18/0.04),0_30px_60px_-30px_rgb(16_16_18/0.35)]"
      transition={SPRING}
    >
      <div className="flex items-center gap-2">
        <motion.span
          layout
          className="inline-block h-3 w-3 rounded-[4px]"
          animate={{ backgroundColor: workspaceName.trim() ? "#6366f1" : "#d9d9de" }}
          transition={{ duration: 0.4 }}
        />
        <motion.span layout className="truncate text-sm font-semibold">
          {ws}
        </motion.span>
        <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground">
          HQ
        </span>
      </div>

      <div className="mt-4 space-y-1.5">
        {["Set up your first list", "Invite a teammate", "Assign a task to an agent"].map(
          (t, i) => (
            <motion.div
              key={t}
              className="flex items-center gap-2 rounded-lg bg-muted/60 px-2.5 py-1.5"
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.15 + i * 0.08, duration: 0.4, ease: EASE }}
            >
              <span className="inline-block h-3 w-3 rounded-full border-2 border-border" />
              <span className="truncate text-[13px] text-foreground/70">{t}</span>
            </motion.div>
          ),
        )}
      </div>

      <AnimatePresence>
        {agentReady && (
          <motion.div
            initial={{ opacity: 0, y: 10, height: 0 }}
            animate={{ opacity: 1, y: 0, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.45, ease: EASE }}
            className="mt-4 overflow-hidden"
          >
            <div className="flex items-center gap-2.5 rounded-xl border border-border bg-background px-3 py-2.5">
              <span className="text-xl" aria-hidden>
                {agentEmoji}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {agentName.trim() || "Your agent"}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {stage === "live" ? "Online" : "Ready to connect"}
                </p>
              </div>
              <PresenceDot online={stage === "live"} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function BuildStep({
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
  const [state, setState] = useState<BuildState>({ phase: "building", step: 0 });
  const [copied, setCopied] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const timers = BUILD_STEPS.map((_, i) =>
      setTimeout(
        () =>
          setState((s) =>
            s.phase === "building" ? { phase: "building", step: i + 1 } : s,
          ),
        550 * (i + 1),
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
        setTimeout(
          () =>
            setState({ phase: "done", key, workspaceId: result.workspaceId }),
          Math.max(0, 550 * (BUILD_STEPS.length + 1)),
        );
      } catch (err) {
        setState({
          phase: "error",
          message: err instanceof Error ? err.message : "Setup failed",
        });
      }
    })();
    return () => timers.forEach(clearTimeout);
  }, [agentEmoji, agentName, completeSetup, createKey, workspaceName]);

  if (state.phase === "error") {
    return (
      <div className="mx-auto max-w-md text-center">
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

  const done = state.phase === "done";

  return (
    <div className="grid items-center gap-10 lg:grid-cols-[1fr_22rem]">
      <div className="order-2 lg:order-1">
        <AnimatePresence mode="wait">
          <motion.h1
            key={done ? "done" : "building"}
            initial={{ opacity: 0, y: 12, filter: "blur(6px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -12, filter: "blur(6px)" }}
            transition={{ duration: 0.5, ease: EASE }}
            className="text-4xl font-bold tracking-[-0.02em] sm:text-5xl"
          >
            {done
              ? `${agentEmoji} ${agentName} is online.`
              : "Building your mission control…"}
          </motion.h1>
        </AnimatePresence>

        <ul className="mt-8 space-y-3">
          {BUILD_STEPS.map((label, i) => {
            const reached =
              done || (state.phase === "building" && state.step > i);
            return (
              <motion.li
                key={label}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: reached ? 1 : 0.3, y: 0 }}
                transition={{ duration: 0.4, ease: EASE, delay: i * 0.06 }}
                className="flex items-center gap-3 text-sm"
              >
                <motion.span
                  initial={false}
                  animate={{
                    backgroundColor: reached ? "#101012" : "#ececee",
                    scale: reached ? 1 : 0.7,
                  }}
                  transition={SPRING}
                  className="inline-block h-2.5 w-2.5 rounded-full"
                />
                <span className={reached ? "" : "text-muted-foreground"}>
                  {label}
                </span>
              </motion.li>
            );
          })}
        </ul>

        <AnimatePresence>
          {done && (
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: EASE, delay: 0.15 }}
              className="mt-10"
            >
              <div className="rounded-2xl bento p-5">
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
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  Point any MCP-capable runtime at{" "}
                  <code className="rounded bg-muted px-1 py-0.5">/api/mcp</code>{" "}
                  with{" "}
                  <code className="rounded bg-muted px-1 py-0.5">
                    Authorization: Bearer &lt;this key&gt;
                  </code>
                  . Your &quot;Getting started&quot; list is already waiting.
                </p>
              </div>

              <Button
                size="lg"
                className="mt-6"
                onClick={() => router.push("/dashboard?welcome=1")}
              >
                Enter mission control
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="order-1 lg:order-2">
        <LivePreview
          workspaceName={workspaceName}
          agentName={agentName}
          agentEmoji={agentEmoji}
          stage={done ? "live" : "agent"}
        />
      </div>
    </div>
  );
}
