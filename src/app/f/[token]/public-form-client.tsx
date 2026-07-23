"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";

type Priority = "urgent" | "high" | "normal" | "low";

const PRIORITY_OPTIONS: { value: Priority; label: string }[] = [
  { value: "urgent", label: "Urgent" },
  { value: "high", label: "High" },
  { value: "normal", label: "Normal" },
  { value: "low", label: "Low" },
];

export function PublicFormClient({ token }: { token: string }) {
  const form = useQuery(api.forms.getPublic, { token });
  const submitPublic = useMutation(api.forms.submitPublic);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("normal");
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  function resetForSubmitAnother() {
    setTitle("");
    setDescription("");
    setPriority("normal");
    setEmail("");
    setError(null);
    setSubmitted(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      await submitPublic({
        token,
        title: title.trim(),
        description: description.trim() || undefined,
        priority: form?.askPriority ? priority : undefined,
        email: email.trim() || undefined,
      });
      setSubmitted(true);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message.split("Uncaught Error:").pop()?.split("\n")[0]?.trim() ||
              "Something went wrong. Please try again."
          : "Something went wrong. Please try again.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-page px-4 py-12">
      <div className="w-full max-w-lg rounded-2xl panel p-8">
        {form === undefined ? (
          <div className="space-y-3">
            <div className="h-6 w-48 animate-pulse rounded-full bg-muted" />
            <div className="h-4 w-64 animate-pulse rounded-full bg-muted" />
            <div className="mt-6 h-10 animate-pulse rounded-full bg-muted" />
            <div className="h-24 animate-pulse rounded-2xl bg-muted" />
          </div>
        ) : form === null ? (
          <div className="py-6 text-center">
            <h1 className="text-lg font-semibold">This form is closed.</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              The link you followed is no longer accepting submissions.
            </p>
          </div>
        ) : submitted ? (
          <div className="py-6 text-center">
            <h1 className="text-lg font-semibold">Thanks — received.</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Your submission was sent to the team.
            </p>
            <Button
              type="button"
              variant="outline"
              className="mt-6"
              onClick={resetForSubmitAnother}
            >
              Submit another
            </Button>
          </div>
        ) : (
          <>
            <h1 className="text-2xl font-bold tracking-tight">
              {form.title}
            </h1>
            {form.description && (
              <p className="mt-2 text-sm text-muted-foreground">
                {form.description}
              </p>
            )}

            <form onSubmit={handleSubmit} className="mt-6 space-y-4">
              <div>
                <label
                  htmlFor="form-title"
                  className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  Title
                </label>
                <input
                  id="form-title"
                  type="text"
                  required
                  maxLength={300}
                  value={title}
                  onChange={(e) => setTitle(e.currentTarget.value)}
                  placeholder="What do you need?"
                  className="soft-field mt-1.5 w-full px-3.5 py-2.5 text-sm"
                />
              </div>

              {form.askDescription && (
                <div>
                  <label
                    htmlFor="form-description"
                    className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                  >
                    Description
                  </label>
                  <textarea
                    id="form-description"
                    rows={4}
                    maxLength={5000}
                    value={description}
                    onChange={(e) => setDescription(e.currentTarget.value)}
                    placeholder="Add any details that would help."
                    className="soft-field mt-1.5 w-full resize-none px-3.5 py-2.5 text-sm"
                  />
                </div>
              )}

              {form.askPriority && (
                <div>
                  <label
                    htmlFor="form-priority"
                    className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                  >
                    Priority
                  </label>
                  <select
                    id="form-priority"
                    value={priority}
                    onChange={(e) =>
                      setPriority(e.currentTarget.value as Priority)
                    }
                    className="soft-field mt-1.5 w-full px-3.5 py-2.5 text-sm"
                  >
                    {PRIORITY_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {form.askEmail && (
                <div>
                  <label
                    htmlFor="form-email"
                    className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                  >
                    Your email
                  </label>
                  <input
                    id="form-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.currentTarget.value)}
                    placeholder="you@example.com"
                    className="soft-field mt-1.5 w-full px-3.5 py-2.5 text-sm"
                  />
                </div>
              )}

              {error && <p className="text-sm text-danger">{error}</p>}

              <Button
                type="submit"
                disabled={!title.trim() || pending}
                className="w-full"
              >
                {pending ? "Sending…" : "Submit"}
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
