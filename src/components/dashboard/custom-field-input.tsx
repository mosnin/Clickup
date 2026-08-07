"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Check, Search, X } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/toast";
import { Picker } from "@/components/ui/picker";
import { fromDateInputValue, toDateInputValue } from "@/lib/dates";
import { errorMessage } from "@/lib/errors";
import {
  DEFAULT_OPTION_COLORS,
  formatComputed,
  formatFileSize,
  formatMoney,
} from "@/lib/custom-fields";

// Type-aware editor for one custom field value on one task.
//
// The parent supplies the stored row (if any) and an onCommit callback that
// receives the exact argument shape `taskFieldValues.set` wants, or `null`
// to clear. Every type gets an editor that feels like the thing it is —
// stars you click, a bar you drag, chips you search — rather than a generic
// input with a label taped to it. The server validates every write, so a
// refusal here surfaces as an error toast with the server's own wording.

export type FieldValue = {
  textValue?: string;
  numberValue?: number;
  booleanValue?: boolean;
  dateValue?: number;
  currency?: string;
  optionIds?: string[];
  actorIds?: string[];
  taskIds?: Id<"tasks">[];
  location?: { label: string; lat?: number; lng?: number };
  files?: {
    storageId: Id<"_storage">;
    name: string;
    mimeType: string;
    sizeBytes: number;
  }[];
};

type Props = {
  field: Doc<"customFields">;
  value: (FieldValue & { taskId?: Id<"tasks"> }) | undefined;
  onCommit: (value: FieldValue | null) => void;
  size?: "sm" | "md";
  /** Needed by people/relationship/files/voting editors. */
  taskId?: Id<"tasks">;
  /** Derived number for rollup/formula fields (and the vote count). */
  computed?: number | null;
  /** The signed-in principal, so a voting field knows if you voted. */
  currentActorId?: string;
};

export function CustomFieldInput(props: Props) {
  const { field } = props;
  switch (field.type) {
    case "text":
    case "email":
    case "phone":
    case "url":
      return <Textish {...props} />;
    case "long_text":
      return <LongText {...props} />;
    case "number":
      return <NumberInput {...props} />;
    case "money":
      return <MoneyInput {...props} />;
    case "rating":
      return <RatingInput {...props} />;
    case "progress":
      return <ProgressInput {...props} />;
    case "checkbox":
      return <CheckboxInput {...props} />;
    case "date":
      return <DateInput {...props} />;
    case "dropdown":
      return <DropdownInput {...props} />;
    case "labels":
      return <LabelsInput {...props} />;
    case "location":
      return <LocationInput {...props} />;
    case "people":
      return <PeopleInput {...props} />;
    case "relationship":
      return <RelationshipInput {...props} />;
    case "files":
      return <FilesInput {...props} />;
    case "voting":
      return <VotingInput {...props} />;
    case "rollup":
    case "formula":
      return <ComputedValue {...props} />;
  }
}

// ── Shared bits ────────────────────────────────────────────────────────

function inputClass(size: "sm" | "md" | undefined) {
  return size === "md"
    ? "soft-field w-full px-3 py-1.5 text-sm"
    : "soft-field px-2 py-1 text-xs";
}

function DebouncedText({
  initial,
  onCommit,
  className,
  inputMode,
  placeholder,
  type = "text",
}: {
  initial: string;
  /** Return `false` to reject the value: the draft reverts to `initial`. */
  onCommit: (value: string) => boolean | void;
  className: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  placeholder?: string;
  type?: string;
}) {
  const [draft, setDraft] = useState(initial);
  useEffect(() => setDraft(initial), [initial]);

  return (
    <input
      type={type}
      inputMode={inputMode}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onBlur={() => {
        if (draft === initial) return;
        if (onCommit(draft) === false) setDraft(initial);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          (e.currentTarget as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          setDraft(initial);
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
      className={className}
    />
  );
}

function optionColor(index: number, explicit?: string) {
  return explicit ?? DEFAULT_OPTION_COLORS[index % DEFAULT_OPTION_COLORS.length];
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return <span className="text-xs text-muted-foreground">{children}</span>;
}

// ── Basic types ────────────────────────────────────────────────────────

function Textish({ field, value, onCommit, size }: Props) {
  const placeholder =
    field.type === "email"
      ? "name@example.com"
      : field.type === "phone"
        ? "+1 415 555 0142"
        : field.type === "url"
          ? "https://example.com"
          : undefined;
  return (
    <DebouncedText
      initial={value?.textValue ?? ""}
      placeholder={placeholder}
      inputMode={
        field.type === "email"
          ? "email"
          : field.type === "phone"
            ? "tel"
            : field.type === "url"
              ? "url"
              : undefined
      }
      onCommit={(v) => onCommit(v.trim() === "" ? null : { textValue: v })}
      className={inputClass(size)}
    />
  );
}

function LongText({ value, onCommit, size }: Props) {
  const initial = value?.textValue ?? "";
  const [draft, setDraft] = useState(initial);
  useEffect(() => setDraft(initial), [initial]);
  return (
    <textarea
      value={draft}
      rows={size === "md" ? 4 : 2}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onBlur={() => {
        if (draft === initial) return;
        onCommit(draft.trim() === "" ? null : { textValue: draft });
      }}
      className={cn(
        "soft-field w-full resize-y px-3 py-2",
        size === "md" ? "text-sm" : "text-xs",
      )}
    />
  );
}

function NumberInput({ field, value, onCommit, size }: Props) {
  const { toast } = useToast();
  const config = field.config;
  return (
    <DebouncedText
      initial={value?.numberValue?.toString() ?? ""}
      inputMode="decimal"
      onCommit={(v) => {
        if (v.trim() === "") return onCommit(null);
        const n = Number(v);
        if (!Number.isFinite(n)) {
          toast(`"${v}" isn't a number`, { kind: "error" });
          return false;
        }
        if (config?.min !== undefined && n < config.min) {
          toast(`Minimum is ${config.min}`, { kind: "error" });
          return false;
        }
        if (config?.max !== undefined && n > config.max) {
          toast(`Maximum is ${config.max}`, { kind: "error" });
          return false;
        }
        onCommit({ numberValue: n });
      }}
      className={inputClass(size)}
    />
  );
}

function MoneyInput({ field, value, onCommit, size }: Props) {
  const { toast } = useToast();
  const currency = value?.currency ?? field.config?.currency ?? "USD";
  const [editing, setEditing] = useState(false);

  if (!editing && value?.numberValue !== undefined) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={cn(
          "soft-field text-left tabular-nums",
          size === "md" ? "w-full px-3 py-1.5 text-sm" : "px-2 py-1 text-xs",
        )}
      >
        {formatMoney(value.numberValue, currency)}
      </button>
    );
  }

  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="flex-shrink-0 text-tiny uppercase tracking-wider text-muted-foreground">
        {currency}
      </span>
      <DebouncedText
        initial={value?.numberValue?.toString() ?? ""}
        inputMode="decimal"
        onCommit={(v) => {
          setEditing(false);
          if (v.trim() === "") return onCommit(null);
          const n = Number(v);
          if (!Number.isFinite(n)) {
            toast(`"${v}" isn't an amount`, { kind: "error" });
            return false;
          }
          onCommit({ numberValue: n, currency });
        }}
        className={cn(inputClass(size), "min-w-0 flex-1")}
      />
    </span>
  );
}

function RatingInput({ field, value, onCommit }: Props) {
  const max = field.config?.ratingMax ?? 5;
  const current = value?.numberValue ?? 0;
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? current;

  return (
    <span
      className="flex items-center gap-0.5"
      onMouseLeave={() => setHover(null)}
      role="radiogroup"
      aria-label={`${field.name} rating`}
    >
      {Array.from({ length: max }, (_, i) => {
        const star = i + 1;
        return (
          <button
            key={star}
            type="button"
            role="radio"
            aria-checked={current === star}
            aria-label={`${star} of ${max}`}
            onMouseEnter={() => setHover(star)}
            onFocus={() => setHover(star)}
            onBlur={() => setHover(null)}
            onClick={() =>
              // Clicking the current rating clears it — the only way back
              // to "unrated" without a separate control.
              onCommit(current === star ? null : { numberValue: star })
            }
            className="tap-target -m-0.5 p-0.5 transition-transform hover:scale-110 active:scale-95"
          >
            <svg
              viewBox="0 0 20 20"
              aria-hidden
              className={cn(
                "h-4 w-4",
                star <= shown
                  ? "text-foreground"
                  : "text-muted-foreground/30",
              )}
              fill="currentColor"
            >
              <path d="M10 1.6l2.47 5.29 5.53.74-4.06 3.9 1.02 5.67L10 14.5l-4.96 2.7 1.02-5.67L2 7.63l5.53-.74z" />
            </svg>
          </button>
        );
      })}
    </span>
  );
}

function ProgressInput({ field, value, onCommit, size }: Props) {
  const stored = value?.numberValue ?? 0;
  const [draft, setDraft] = useState<number | null>(null);
  const pct = draft ?? stored;
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  useEffect(() => setDraft(null), [stored]);

  function pctFromEvent(clientX: number): number {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return stored;
    const raw = ((clientX - rect.left) / rect.width) * 100;
    return Math.max(0, Math.min(100, Math.round(raw)));
  }

  function commit(next: number) {
    dragging.current = false;
    setDraft(null);
    onCommit(next === 0 ? null : { numberValue: next });
  }

  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-2",
        size === "md" ? "w-full" : "w-28",
      )}
    >
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label={field.name}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        onPointerDown={(e) => {
          e.preventDefault();
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          setDraft(pctFromEvent(e.clientX));
        }}
        onPointerMove={(e) => {
          if (!dragging.current) return;
          setDraft(pctFromEvent(e.clientX));
        }}
        onPointerUp={(e) => {
          if (!dragging.current) return;
          commit(pctFromEvent(e.clientX));
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowUp") {
            e.preventDefault();
            commit(Math.min(100, pct + 5));
          } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
            e.preventDefault();
            commit(Math.max(0, pct - 5));
          }
        }}
        className="h-4 min-w-0 flex-1 cursor-ew-resize touch-none rounded-full py-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground"
      >
        <span
          aria-hidden
          className="block h-1.5 overflow-hidden rounded-full bg-foreground/10"
        >
          <span
            className="block h-full rounded-full bg-foreground transition-[width] duration-150"
            style={{ width: `${pct}%` }}
          />
        </span>
      </div>
      <span className="w-9 flex-shrink-0 text-right text-tiny tabular-nums text-muted-foreground">
        {pct}%
      </span>
    </span>
  );
}

function CheckboxInput({ value, onCommit }: Props) {
  return (
    <input
      type="checkbox"
      checked={!!value?.booleanValue}
      onChange={(e) =>
        onCommit(
          e.currentTarget.checked ? { booleanValue: true } : { booleanValue: false },
        )
      }
      className="h-4 w-4 rounded border-border accent-[var(--color-foreground)]"
    />
  );
}

function DateInput({ value, onCommit, size }: Props) {
  return (
    <input
      type="date"
      value={value?.dateValue ? toDateInputValue(value.dateValue) : ""}
      onChange={(e) => {
        const ts = fromDateInputValue(e.currentTarget.value);
        onCommit(ts !== undefined ? { dateValue: ts } : null);
      }}
      className={inputClass(size)}
    />
  );
}

function DropdownInput({ field, value, onCommit }: Props) {
  const options = field.options ?? [];
  const selected = options.find((o) => o.id === value?.textValue);
  return (
    <Picker
      label={selected?.label ?? "—"}
      selectedId={selected?.id}
      dashed={!selected}
      options={[
        { id: "", label: "Clear" },
        ...options.map((o) => ({ id: o.id, label: o.label })),
      ]}
      onSelect={(id) => onCommit(id ? { textValue: id } : null)}
    />
  );
}

// ── Labels: chips + a searchable popover ───────────────────────────────

function LabelsInput({ field, value, onCommit }: Props) {
  const options = useMemo(() => field.options ?? [], [field.options]);
  const selected = value?.optionIds ?? [];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? options.filter((o) => o.label.toLowerCase().includes(q))
      : options;
  }, [options, query]);

  function toggle(id: string) {
    const next = selected.includes(id)
      ? selected.filter((x) => x !== id)
      : [...selected, id];
    onCommit(next.length === 0 ? null : { optionIds: next });
  }

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "flex min-h-8 w-full min-w-0 flex-wrap items-center gap-1 rounded-full px-2 py-1 text-left",
          selected.length === 0
            ? "border border-dashed border-border text-xs text-muted-foreground"
            : "soft-field",
        )}
      >
        {selected.length === 0 && <span>+ Labels</span>}
        {selected.map((id) => {
          const idx = options.findIndex((o) => o.id === id);
          const opt = options[idx];
          return (
            <span
              key={id}
              className="max-w-full truncate rounded-full px-2 py-0.5 text-tiny"
              style={{ backgroundColor: optionColor(idx, opt?.color) }}
            >
              {opt?.label ?? id}
            </span>
          );
        })}
      </button>

      {open && (
        <div className="absolute left-0 z-50 mt-1 w-56 max-w-[80vw] overflow-hidden rounded-2xl border border-border bg-popover shadow-lg">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder="Search labels…"
              aria-label="Search labels"
              className="w-full min-w-0 bg-transparent text-sm focus:outline-none"
            />
          </div>
          <ul className="max-h-56 overflow-y-auto p-1">
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-sm text-muted-foreground">
                No matches.
              </li>
            )}
            {filtered.map((opt) => {
              const idx = options.findIndex((o) => o.id === opt.id);
              const on = selected.includes(opt.id);
              return (
                <li key={opt.id}>
                  <button
                    type="button"
                    onClick={() => toggle(opt.id)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    <span
                      aria-hidden
                      className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                      style={{ backgroundColor: optionColor(idx, opt.color) }}
                    />
                    <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                    {on && <Check className="h-3.5 w-3.5 flex-shrink-0" />}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Location ───────────────────────────────────────────────────────────

function LocationInput({ value, onCommit, size }: Props) {
  const loc = value?.location;
  const [showCoords, setShowCoords] = useState(
    loc?.lat !== undefined || loc?.lng !== undefined,
  );

  return (
    <span className="flex min-w-0 flex-col gap-1">
      <DebouncedText
        initial={loc?.label ?? ""}
        placeholder="City, address, or place"
        onCommit={(v) =>
          onCommit(
            v.trim() === ""
              ? null
              : { location: { label: v, lat: loc?.lat, lng: loc?.lng } },
          )
        }
        className={inputClass(size)}
      />
      {showCoords ? (
        <span className="flex min-w-0 items-center gap-1">
          <DebouncedText
            initial={loc?.lat?.toString() ?? ""}
            placeholder="lat"
            inputMode="decimal"
            onCommit={(v) => {
              if (!loc?.label) return false;
              const lat = v.trim() === "" ? undefined : Number(v);
              if (lat !== undefined && !Number.isFinite(lat)) return false;
              onCommit({ location: { ...loc, lat } });
            }}
            className={cn(inputClass(size), "w-20 min-w-0")}
          />
          <DebouncedText
            initial={loc?.lng?.toString() ?? ""}
            placeholder="lng"
            inputMode="decimal"
            onCommit={(v) => {
              if (!loc?.label) return false;
              const lng = v.trim() === "" ? undefined : Number(v);
              if (lng !== undefined && !Number.isFinite(lng)) return false;
              onCommit({ location: { ...loc, lng } });
            }}
            className={cn(inputClass(size), "w-20 min-w-0")}
          />
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setShowCoords(true)}
          className="self-start text-tiny text-muted-foreground hover:text-foreground"
        >
          + coordinates
        </button>
      )}
    </span>
  );
}

// ── People ─────────────────────────────────────────────────────────────

function PeopleInput({ field, value, onCommit }: Props) {
  const assignable = useQuery(api.agents.listAssignableForList, {
    listId: field.listId,
  });
  const selected = value?.actorIds ?? [];
  const byId = useMemo(
    () => new Map((assignable ?? []).map((a) => [a.id, a])),
    [assignable],
  );
  const single = field.config?.multiple === false;

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {selected.map((id) => (
        <span
          key={id}
          className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-tiny"
        >
          <span className="truncate">{byId.get(id)?.name ?? id}</span>
          <button
            type="button"
            aria-label={`Remove ${byId.get(id)?.name ?? id}`}
            onClick={() => {
              const next = selected.filter((x) => x !== id);
              onCommit(next.length === 0 ? null : { actorIds: next });
            }}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      {(!single || selected.length === 0) && (
        <Picker
          dashed
          label={selected.length === 0 ? "+ Add" : "+"}
          options={(assignable ?? [])
            .filter((a) => !selected.includes(a.id))
            .map((a) => ({
              id: a.id,
              label: a.name,
              hint: a.kind === "agent" ? "agent" : undefined,
            }))}
          onSelect={(id) =>
            onCommit({ actorIds: single ? [id] : [...selected, id] })
          }
        />
      )}
    </span>
  );
}

// ── Relationship ───────────────────────────────────────────────────────

function RelationshipInput({ field, value, onCommit, taskId }: Props) {
  const targetListId = field.config?.relationListId ?? field.listId;
  const tasks = useQuery(api.tasks.listForList, { listId: targetListId });
  const selected = value?.taskIds ?? [];
  const selfId = taskId ?? value?.taskId;
  const byId = useMemo(
    () => new Map((tasks ?? []).map((t) => [t._id as string, t])),
    [tasks],
  );
  const single = field.config?.multiple === false;

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {selected.map((id) => (
        <span
          key={id}
          className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-tiny"
        >
          <span className="max-w-32 truncate">
            {byId.get(id)?.title ?? "Linked task"}
          </span>
          <button
            type="button"
            aria-label="Unlink task"
            onClick={() => {
              const next = selected.filter((x) => x !== id);
              onCommit(next.length === 0 ? null : { taskIds: next });
            }}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      {(!single || selected.length === 0) && (
        <Picker
          dashed
          label={selected.length === 0 ? "+ Link" : "+"}
          options={(tasks ?? [])
            .filter((t) => t._id !== selfId && !selected.includes(t._id))
            .slice(0, 200)
            .map((t) => ({ id: t._id, label: t.title }))}
          onSelect={(id) =>
            onCommit({
              taskIds: single
                ? [id as Id<"tasks">]
                : [...selected, id as Id<"tasks">],
            })
          }
        />
      )}
    </span>
  );
}

// ── Files ──────────────────────────────────────────────────────────────

function FilesInput({ field, value, onCommit, taskId }: Props) {
  const generateUploadUrl = useMutation(api.taskFieldValues.generateUploadUrl);
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const resolvedTaskId = taskId ?? value?.taskId;
  const files = value?.files ?? [];

  const urls = useQuery(
    api.taskFieldValues.fileUrls,
    resolvedTaskId && files.length > 0
      ? { taskId: resolvedTaskId, fieldId: field._id }
      : "skip",
  );
  const urlByStorage = useMemo(
    () => new Map((urls ?? []).map((u) => [u.storageId as string, u.url])),
    [urls],
  );

  async function upload(list: FileList | null) {
    if (!list || list.length === 0) return;
    setBusy(true);
    try {
      const uploaded: NonNullable<FieldValue["files"]> = [];
      for (const file of Array.from(list)) {
        const url = await generateUploadUrl({});
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!res.ok) throw new Error("Upload failed");
        const { storageId } = (await res.json()) as {
          storageId: Id<"_storage">;
        };
        uploaded.push({
          storageId,
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
        });
      }
      onCommit({ files: [...files, ...uploaded] });
    } catch (e) {
      toast(errorMessage(e, "Couldn't upload that file"), { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-w-0 space-y-1">
      {files.length > 0 && (
        <ul className="flex min-w-0 flex-wrap gap-1">
          {files.map((f) => {
            const href = urlByStorage.get(f.storageId);
            return (
              <li
                key={f.storageId}
                className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-tiny"
              >
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className="max-w-32 truncate underline-offset-2 hover:underline"
                  >
                    {f.name}
                  </a>
                ) : (
                  <span className="max-w-32 truncate">{f.name}</span>
                )}
                <span className="flex-shrink-0 text-muted-foreground">
                  {formatFileSize(f.sizeBytes)}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => {
                    const next = files.filter(
                      (x) => x.storageId !== f.storageId,
                    );
                    onCommit(next.length === 0 ? null : { files: next });
                  }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void upload(e.dataTransfer.files);
        }}
        className={cn(
          "rounded-xl border border-dashed px-2 py-1.5 text-center text-tiny transition-colors",
          over
            ? "border-foreground/40 bg-muted text-foreground"
            : "border-border text-muted-foreground",
        )}
      >
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="w-full disabled:opacity-60"
        >
          {busy ? "Uploading…" : "Drop files or choose"}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            void upload(e.currentTarget.files);
            e.currentTarget.value = "";
          }}
        />
      </div>
    </div>
  );
}

// ── Voting ─────────────────────────────────────────────────────────────

function VotingInput({ value, onCommit, computed, currentActorId }: Props) {
  const voters = value?.actorIds ?? [];
  const count = computed ?? voters.length;
  const mine = currentActorId ? voters.includes(currentActorId) : false;

  return (
    <button
      type="button"
      onClick={() => onCommit({ booleanValue: !mine })}
      aria-pressed={mine}
      className={cn(
        "tap-target inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors active:scale-95",
        mine
          ? "bg-foreground text-background"
          : "soft-field text-muted-foreground hover:text-foreground",
      )}
    >
      <span aria-hidden>▲</span>
      <span className="tabular-nums">{count}</span>
    </button>
  );
}

// ── Computed (rollup / formula) ────────────────────────────────────────

function ComputedValue({ field, computed, size }: Props) {
  const hint =
    field.type === "formula"
      ? field.config?.formula
      : field.config?.rollup
        ? `${field.config.rollup.op} of ${field.config.rollup.source}`
        : undefined;

  if (computed === undefined) {
    return <Placeholder>—</Placeholder>;
  }
  return (
    <span
      title={hint}
      className={cn(
        "inline-flex items-baseline gap-1.5 tabular-nums",
        size === "md" ? "text-sm" : "text-xs",
      )}
    >
      <span className="font-medium">{formatComputed(computed)}</span>
      {size === "md" && hint && (
        <span className="truncate font-mono text-micro text-muted-foreground">
          {hint}
        </span>
      )}
    </span>
  );
}
