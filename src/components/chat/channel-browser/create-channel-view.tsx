"use client";

// Create mode of the channel browser (§1.2).
//
// It is a *mode*, not a second dialog, because "browse or create" is one
// decision: you find out the room does not exist by looking for it, and the
// answer to that is right there rather than behind a different button in a
// different corner. The back arrow returns to the search you were already
// doing, with the query intact.
//
// The one thing this form does that a normal form does not: it shows you the
// name you are actually going to get. `#Release Notes` is stored as
// `release-notes`, and a person who is not told that will type it twice.

import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ChatChannelVisibility } from "@/lib/buzz/channel-types";
import {
  canonicalChannelName,
  type BrowsableChannelKind,
} from "@/lib/buzz/channel-search";
import {
  CHANNEL_TEMPLATES,
  DEFAULT_EPHEMERAL_TTL_SECONDS,
  TTL_CHOICES,
  templateById,
} from "./templates";

export type CreateChannelInput = {
  name: string;
  description?: string;
  kind: BrowsableChannelKind;
  visibility: ChatChannelVisibility;
  /** Present only for a temporary room. Absent means "ongoing". */
  ttlSeconds?: number;
  templateId?: string;
};

export function CreateChannelView({
  initialName,
  kind,
  noun,
  creating,
  onBack,
  onCreate,
}: {
  initialName: string;
  kind: BrowsableChannelKind;
  /** "channel" or "forum" — every string in the dialog swaps on this. */
  noun: string;
  creating: boolean;
  onBack: () => void;
  onCreate: (input: CreateChannelInput) => Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<ChatChannelVisibility>("public");
  const [ephemeral, setEphemeral] = useState(false);
  const [ttlSeconds, setTtlSeconds] = useState(DEFAULT_EPHEMERAL_TTL_SECONDS);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // Whether the person has expressed an opinion about visibility. A template
  // may suggest one; it may never overrule one that was chosen on purpose.
  const visibilityTouched = useRef(false);

  useEffect(() => {
    // The caret goes to the *end* of the prefilled name, not to the start and
    // not over a selection: you arrived here having typed that name, and the
    // next keystroke should continue it rather than replace it.
    const input = nameRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, []);

  const canonical = canonicalChannelName(name);
  const renamed = canonical.length > 0 && canonical !== name.trim();

  function chooseTemplate(id: string | null) {
    setTemplateId(id);
    const template = templateById(id);
    setDescription(template?.description ?? "");
    if (template && !visibilityTouched.current) setVisibility(template.visibility);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (canonical.length === 0 || creating) return;
    setError(null);
    try {
      await onCreate({
        name: canonical,
        description: description.trim() || undefined,
        kind,
        visibility,
        ttlSeconds: ephemeral ? ttlSeconds : undefined,
        templateId: templateId ?? undefined,
      });
    } catch (err) {
      // The server's own reason, when there is one — "a channel by that name
      // already exists" is far more useful than "failed to create channel",
      // and it is the message that tells someone what to do next.
      setError(
        err instanceof Error && err.message
          ? err.message
          : `Failed to create ${noun}.`,
      );
    }
  }

  return (
    <form id="create-channel-form" onSubmit={submit} className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="tap-target inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Back to search"
        >
          <ArrowLeft aria-hidden className="size-4" />
        </button>
        <h2 className="text-base font-semibold">New {noun}</h2>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="new-channel-name" className="text-tiny font-medium uppercase tracking-wider text-muted-foreground">
          Name
        </label>
        <div className="soft-field flex items-center gap-1 px-3">
          <span aria-hidden className="text-sm text-muted-foreground">
            #
          </span>
          <input
            id="new-channel-name"
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder={`${noun}-name`}
            className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        {/* The canonicalisation feedback. Only shown when the answer differs
            from what was typed — telling someone their already-lowercase name
            will be lowercased is noise. */}
        {renamed ? (
          <p className="text-xs text-muted-foreground">
            Will be created as <span className="font-medium text-foreground">#{canonical}</span>
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="new-channel-description" className="text-tiny font-medium uppercase tracking-wider text-muted-foreground">
          Description
        </label>
        <textarea
          id="new-channel-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="What is this room for?"
          className="soft-field w-full resize-none px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-tiny font-medium uppercase tracking-wider text-muted-foreground">
          Start from
        </legend>
        <div className="segmented flex-wrap" role="radiogroup" aria-label="Template">
          {CHANNEL_TEMPLATES.filter((t) => t.kind === kind).map((template) => {
            const on = (templateId ?? "blank") === template.id;
            return (
              <button
                key={template.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => chooseTemplate(template.id === "blank" ? null : template.id)}
                className={cn(on && "segmented-on")}
              >
                {template.name}
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-tiny font-medium uppercase tracking-wider text-muted-foreground">
          Visibility
        </legend>
        <div className="segmented" role="radiogroup" aria-label="Visibility">
          {(["public", "private"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={visibility === option}
              onClick={() => {
                visibilityTouched.current = true;
                setVisibility(option);
              }}
              className={cn(visibility === option && "segmented-on")}
            >
              {option === "public" ? "Anyone can join" : "Invite only"}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-tiny font-medium uppercase tracking-wider text-muted-foreground">
          Lifetime
        </legend>
        <div className="segmented" role="radiogroup" aria-label="Lifetime">
          {[false, true].map((temp) => (
            <button
              key={String(temp)}
              type="button"
              role="radio"
              aria-checked={ephemeral === temp}
              onClick={() => setEphemeral(temp)}
              className={cn(ephemeral === temp && "segmented-on")}
            >
              {temp ? "Temporary" : "Ongoing"}
            </button>
          ))}
        </div>
        {ephemeral ? (
          <div className="mt-1 flex flex-col gap-1.5">
            <div className="segmented" role="radiogroup" aria-label="Cleans up after">
              {TTL_CHOICES.map((choice) => (
                <button
                  key={choice.seconds}
                  type="button"
                  role="radio"
                  aria-checked={ttlSeconds === choice.seconds}
                  onClick={() => setTtlSeconds(choice.seconds)}
                  className={cn(ttlSeconds === choice.seconds && "segmented-on")}
                >
                  {choice.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Cleans up after that long with no activity.
            </p>
          </div>
        ) : null}
      </fieldset>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onBack}>
          Cancel
        </Button>
        <Button type="submit" disabled={canonical.length === 0 || creating}>
          {creating ? "Creating…" : `Create ${noun}`}
        </Button>
      </div>
    </form>
  );
}
