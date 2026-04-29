"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeft, ArrowRight, Mail, Sparkles, X } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// 3-step wizard. Each step skips cleanly so a Solo user can blow
// through the whole flow with one button per step.
//
//   Step 1: workspace name (or "Use Pace solo")
//   Step 2: invite teammates (only if a workspace was created)
//   Step 3: pick a starter list template (or skip)
//   Done:  completeOnboarding + route to the right place

type Step = 1 | 2 | 3;

export function OnboardingForm() {
  const router = useRouter();
  const createWorkspace = useMutation(api.workspaces.create);
  const createInvite = useMutation(api.invitations.create);
  const applyTemplate = useMutation(api.templates.applyListTemplate);
  const completeOnboarding = useMutation(api.users.completeOnboarding);
  const personalSpaceId = useQuery(api.users.personalSpaceId, {});
  const templates = useQuery(api.templates.list, {});

  const [step, setStep] = useState<Step>(1);
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceId, setWorkspaceId] = useState<Id<"workspaces"> | null>(null);
  const [inviteEmails, setInviteEmails] = useState<string[]>([]);
  const [inviteDraft, setInviteDraft] = useState("");
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function finish() {
    setPending(true);
    setError(null);
    try {
      // Apply template, if any. Personal scope so Solo users see it too.
      if (templateId && personalSpaceId) {
        const t = templates?.find((tt) => tt.id === templateId);
        await applyTemplate({
          templateId,
          name: t?.name ?? "Welcome",
          parentType: "space",
          parentId: personalSpaceId,
        });
      }
      // Send invites in parallel; failures of one shouldn't drop the rest.
      if (workspaceId && inviteEmails.length > 0) {
        await Promise.allSettled(
          inviteEmails.map((email) =>
            createInvite({
              workspaceId,
              email,
              role: "member",
            }),
          ),
        );
      }
      await completeOnboarding({});
      router.push(workspaceId ? `/dashboard/w/${workspaceId}` : "/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setPending(false);
    }
  }

  return (
    <div className="rounded-3xl border border-border bg-background p-6 shadow-sm">
      <Steps current={step} hasWorkspace={workspaceId !== null} />

      <div className="mt-6">
        {step === 1 && (
          <StepWorkspace
            value={workspaceName}
            onChange={setWorkspaceName}
            pending={pending}
            error={error}
            onCreate={async () => {
              if (!workspaceName.trim()) return;
              setPending(true);
              setError(null);
              try {
                const id = await createWorkspace({ name: workspaceName.trim() });
                setWorkspaceId(id);
                setStep(2);
              } catch (err) {
                setError(
                  err instanceof Error ? err.message : "Failed to create",
                );
              } finally {
                setPending(false);
              }
            }}
            onSkip={() => {
              setWorkspaceId(null);
              setInviteEmails([]);
              setStep(3);
            }}
          />
        )}

        {step === 2 && (
          <StepInvite
            emails={inviteEmails}
            draft={inviteDraft}
            onDraftChange={setInviteDraft}
            onAdd={() => {
              const next = inviteDraft.trim().toLowerCase();
              if (!next) return;
              if (!/^\S+@\S+\.\S+$/.test(next)) {
                setError("That doesn't look like an email");
                return;
              }
              if (inviteEmails.includes(next)) {
                setInviteDraft("");
                return;
              }
              setInviteEmails((curr) => [...curr, next]);
              setInviteDraft("");
              setError(null);
            }}
            onRemove={(email) =>
              setInviteEmails((curr) => curr.filter((e) => e !== email))
            }
            error={error}
            onBack={() => setStep(1)}
            onNext={() => {
              setStep(3);
              setError(null);
            }}
          />
        )}

        {step === 3 && (
          <StepTemplate
            templates={templates ?? []}
            selected={templateId}
            onSelect={setTemplateId}
            error={error}
            pending={pending}
            onBack={() =>
              setStep(workspaceId ? 2 : 1)
            }
            onFinish={finish}
          />
        )}
      </div>
    </div>
  );
}

function Steps({ current, hasWorkspace }: { current: Step; hasWorkspace: boolean }) {
  const labels = ["Workspace", "Invite", "Starter"] as const;
  return (
    <ol className="flex items-center gap-3 text-xs">
      {labels.map((label, i) => {
        const n = (i + 1) as Step;
        const skipped = n === 2 && !hasWorkspace && current >= 3;
        const active = n === current;
        const done = n < current && !skipped;
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              className={cn(
                "inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium",
                done && "bg-brand-600 text-white",
                active && "border-2 border-brand-600 text-foreground",
                !done && !active && "border border-border text-muted-foreground",
              )}
            >
              {done ? "✓" : n}
            </span>
            <span
              className={cn(
                active ? "font-medium text-foreground" : "text-muted-foreground",
                skipped && "line-through",
              )}
            >
              {label}
            </span>
            {n < 3 && <span className="text-muted-foreground">·</span>}
          </li>
        );
      })}
    </ol>
  );
}

function StepWorkspace({
  value,
  onChange,
  pending,
  error,
  onCreate,
  onSkip,
}: {
  value: string;
  onChange: (v: string) => void;
  pending: boolean;
  error: string | null;
  onCreate: () => void;
  onSkip: () => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onCreate();
      }}
    >
      <h2 className="text-lg font-semibold">Working with a team?</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Name your team workspace. You can rename it later.
      </p>
      <input
        autoFocus
        required={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Acme"
        className="mt-4 w-full rounded-full border border-border bg-background px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
      />
      {error && (
        <p className="mt-3 rounded-2xl bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-between">
        <Button type="button" variant="ghost" onClick={onSkip} disabled={pending}>
          Use Pace solo
        </Button>
        <Button
          type="submit"
          disabled={!value.trim() || pending}
        >
          {pending ? "Creating…" : "Next"} <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </form>
  );
}

function StepInvite({
  emails,
  draft,
  onDraftChange,
  onAdd,
  onRemove,
  error,
  onBack,
  onNext,
}: {
  emails: string[];
  draft: string;
  onDraftChange: (v: string) => void;
  onAdd: () => void;
  onRemove: (email: string) => void;
  error: string | null;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div>
      <h2 className="text-lg font-semibold">Invite teammates</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        We&apos;ll email them a magic link. Skip and invite later from
        workspace settings.
      </p>
      <div className="mt-4 flex gap-2">
        <Mail className="mt-2 h-4 w-4 text-muted-foreground" aria-hidden />
        <input
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              onAdd();
            }
          }}
          placeholder="teammate@example.com"
          className="flex-1 rounded-full border border-border bg-background px-3 py-1.5 text-sm"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onAdd}
          disabled={!draft.trim()}
        >
          Add
        </Button>
      </div>
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
      {emails.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {emails.map((e) => (
            <li
              key={e}
              className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-1 text-xs text-brand-700"
            >
              {e}
              <button
                type="button"
                onClick={() => onRemove(e)}
                aria-label={`Remove ${e}`}
                className="text-brand-700/70 hover:text-brand-700"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-6 flex justify-between">
        <Button type="button" variant="ghost" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <Button type="button" onClick={onNext}>
          {emails.length === 0 ? "Skip" : "Next"} <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function StepTemplate({
  templates,
  selected,
  onSelect,
  pending,
  error,
  onBack,
  onFinish,
}: {
  templates: { id: string; name: string; emoji: string; description: string }[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  pending: boolean;
  error: string | null;
  onBack: () => void;
  onFinish: () => void;
}) {
  return (
    <div>
      <h2 className="text-lg font-semibold">Pick a starter list</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Drops a list with statuses, fields, and example tasks into your personal
        space. Skip if you&apos;d rather start blank.
      </p>
      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {templates.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => onSelect(selected === t.id ? null : t.id)}
              className={cn(
                "w-full rounded-3xl border p-3 text-left transition-colors",
                selected === t.id
                  ? "border-brand-500 bg-brand-50/50"
                  : "border-border bg-background hover:border-brand-500",
              )}
            >
              <div className="flex items-baseline gap-2">
                <span aria-hidden>{t.emoji}</span>
                <span className="text-sm font-medium">{t.name}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {t.description}
              </p>
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p className="mt-3 rounded-2xl bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="mt-6 flex justify-between">
        <Button type="button" variant="ghost" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <Button type="button" onClick={onFinish} disabled={pending}>
          <Sparkles className="h-4 w-4" />
          {pending ? "Setting up…" : selected ? "Finish" : "Skip and finish"}
        </Button>
      </div>
    </div>
  );
}
