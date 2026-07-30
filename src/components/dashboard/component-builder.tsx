"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";
import { UserComponent } from "@/components/dashboard/user-component";
import {
  DEFAULT_COMPONENT,
  describeComponent,
  fieldsFor,
  normalizeComponent,
  shapesFor,
  type Shape,
  type SourceKind,
  type UiComponentDef,
} from "@/lib/ui-components";
import { cn } from "@/lib/utils";

// Authoring a panel.
//
// The thing that separates this from a settings page: the preview to the right
// is not a mockup, it is the panel — the same renderer, running the same query,
// against your real data. What you are looking at while you choose is the thing
// you get, so there is no gap for a preview to lie in.
//
// The vocabulary is deliberately small and every control is a choice among
// named things rather than a value to type. You are not writing a query; you
// are answering "what do you want to see" in the product's own words.

export function ComponentBuilder({
  scopeType,
  scopeId,
  onCreated,
}: {
  scopeType: "user" | "workspace";
  scopeId: string;
  onCreated: (componentId: string) => void;
}) {
  const create = useMutation(api.uiComponents.create);
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [def, setDef] = useState<UiComponentDef>(DEFAULT_COMPONENT);

  function patch(next: Partial<UiComponentDef>) {
    // Every edit round-trips the normalizer, so a change that invalidates
    // another field (a shape its new source can't draw) is repaired as you
    // make it rather than at save time.
    setDef((current) => normalizeComponent({ ...current, ...next }));
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="bento-tile flex w-full items-center justify-between gap-2 p-3 text-left transition-colors hover:bg-accent"
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium">Build a panel</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
            Pick what to show and how to show it. It becomes a panel you can put
            on any screen.
          </span>
        </span>
        <span className="text-lg leading-none text-muted-foreground">+</span>
      </button>
    );
  }

  const catalog = fieldsFor(def.from);

  return (
    <div className="panel rounded-2xl p-4">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
        <div className="min-w-0 space-y-4">
          <input
            value={def.title}
            onChange={(e) => patch({ title: e.currentTarget.value })}
            aria-label="Panel name"
            placeholder="Name this panel"
            className="soft-field w-full px-3 py-2 text-sm"
          />

          <Choice
            label="Show"
            value={def.from}
            options={[
              ["tasks", "Tasks"],
              ["pages", "Pages"],
              ["agents", "Agents"],
              ["activity", "Activity"],
            ]}
            onPick={(from) => patch({ from: from as SourceKind })}
          />

          <Choice
            label="As"
            value={def.shape}
            options={shapesFor(def.from).map((s) => [
              s,
              s[0].toUpperCase() + s.slice(1),
            ])}
            onPick={(shape) => patch({ shape: shape as Shape })}
          />

          {def.from === "tasks" && (
            <>
              <Choice
                label="Status"
                value={def.filter.status}
                options={[
                  ["any", "Any"],
                  ["open", "To do"],
                  ["in_progress", "In progress"],
                  ["complete", "Complete"],
                ]}
                onPick={(status) =>
                  patch({ filter: { ...def.filter, status: status as never } })
                }
              />
              <Choice
                label="Assigned to"
                value={def.filter.assignee}
                options={[
                  ["anyone", "Anyone"],
                  ["me", "Me"],
                  ["unassigned", "Nobody"],
                  ["agents", "Agents"],
                ]}
                onPick={(assignee) =>
                  patch({
                    filter: { ...def.filter, assignee: assignee as never },
                  })
                }
              />
              <Choice
                label="Due"
                value={def.filter.due}
                options={[
                  ["any", "Any time"],
                  ["overdue", "Overdue"],
                  ["today", "Today"],
                  ["week", "This week"],
                  ["none", "No date"],
                ]}
                onPick={(due) =>
                  patch({ filter: { ...def.filter, due: due as never } })
                }
              />
              <div className="flex flex-wrap gap-2">
                <Toggle
                  label="Blocked only"
                  on={def.filter.blocked}
                  onToggle={() =>
                    patch({
                      filter: { ...def.filter, blocked: !def.filter.blocked },
                    })
                  }
                />
                <Toggle
                  label="Waiting on approval"
                  on={def.filter.needsApproval}
                  onToggle={() =>
                    patch({
                      filter: {
                        ...def.filter,
                        needsApproval: !def.filter.needsApproval,
                      },
                    })
                  }
                />
              </div>
            </>
          )}

          {def.shape === "metric" ? (
            <Choice
              label="Measure"
              value={def.metric}
              options={[
                ["count", "How many"],
                ["completion", "Percent complete"],
                ["overdue", "Overdue"],
                ["estimate_sum", "Total estimate"],
                ["unassigned", "Unassigned"],
              ]}
              onPick={(metric) => patch({ metric: metric as never })}
            />
          ) : (
            <div>
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Fields
              </span>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {catalog.map((f) => {
                  const on = def.fields.includes(f.key);
                  return (
                    <button
                      key={f.key}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        patch({
                          fields: on
                            ? def.fields.filter((k) => k !== f.key)
                            : [...def.fields, f.key],
                        })
                      }
                      className={cn(
                        "rounded-full px-2.5 py-1 text-xs transition-colors",
                        on
                          ? "bg-foreground text-background"
                          : "bento-tile text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {f.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <label className="block">
            <span className="flex items-baseline justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Rows
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {def.limit}
              </span>
            </span>
            <input
              type="range"
              min={1}
              max={50}
              value={def.limit}
              aria-label="Rows"
              onChange={(e) =>
                patch({ limit: Number.parseInt(e.currentTarget.value, 10) })
              }
              className="mt-2 w-full accent-foreground"
            />
          </label>

          <p className="text-xs leading-relaxed text-muted-foreground">
            {describeComponent(def)}
          </p>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => {
                void create({ scopeType, scopeId, definition: def })
                  .then((id) => {
                    setOpen(false);
                    setDef(DEFAULT_COMPONENT);
                    onCreated(id as string);
                    toast("Panel added to this screen");
                  })
                  .catch((e) =>
                    toast(errorMessage(e, "Couldn't create that panel"), {
                      kind: "error",
                    }),
                  );
              }}
            >
              Add to screen
            </Button>
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>

        {/* Not a mockup — the panel itself, running the same query it will run
            once it exists. */}
        <div className="min-w-0">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Preview
          </span>
          <div className="mt-2">
            <UserComponent
              definition={def}
              scopeType={scopeType}
              scopeId={scopeId}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function Choice({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onPick: (value: string) => void;
}) {
  return (
    <div>
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <div className="segmented mt-2 w-full">
        {options.map(([v, text]) => (
          <button
            key={v}
            type="button"
            aria-pressed={value === v}
            onClick={() => onPick(v)}
            className={cn(
              "min-w-0 flex-1 truncate px-2 py-1.5 text-xs",
              value === v && "segmented-on",
            )}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function Toggle({
  label,
  on,
  onToggle,
}: {
  label: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      className={cn(
        "rounded-full px-3 py-1.5 text-xs transition-colors",
        on
          ? "bg-foreground text-background"
          : "bento-tile text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}
