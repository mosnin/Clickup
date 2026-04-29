"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function OnboardingForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);

    // TODO(convex): replace with `useMutation(api.workspaces.create)` once
    // `npx convex dev` has been run and the generated client is available.
    // For now, just bounce to the dashboard so the flow is exercisable.
    await new Promise((r) => setTimeout(r, 300));

    router.push("/dashboard");
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
