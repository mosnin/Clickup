"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";

export function OnboardingForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createWorkspace = useMutation(api.workspaces.create);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const workspaceId = await createWorkspace({ name: name.trim() });
      router.push(`/dashboard/w/${workspaceId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create workspace");
      setPending(false);
    }
  }

  function skip() {
    router.push("/dashboard");
  }

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-3xl border border-border bg-background p-6 shadow-sm"
    >
      <label className="block">
        <span className="text-sm font-medium">Team workspace name</span>
        <input
          required
          minLength={2}
          maxLength={48}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Acme Inc."
          className="mt-2 w-full rounded-full border border-border bg-background px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <span className="mt-2 block text-xs text-muted-foreground">
          You can invite teammates after creating the workspace.
        </span>
      </label>

      {error && (
        <p className="mt-3 rounded-2xl bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" onClick={skip} disabled={pending}>
          Skip for now
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create workspace"}
        </Button>
      </div>
    </form>
  );
}
