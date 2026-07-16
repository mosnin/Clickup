"use client";

import { useEffect, useState } from "react";
import type { Doc } from "@convex/_generated/dataModel";
import { fromDateInputValue, toDateInputValue } from "@/lib/dates";

// Renders an input appropriate for a given custom field type. The parent
// supplies the current value and an onChange callback that receives the
// raw primitive (string | number | boolean | Date timestamp). Empty is
// represented as `null` so the parent can clear the value.

type FieldValue = {
  textValue?: string;
  numberValue?: number;
  booleanValue?: boolean;
  dateValue?: number;
};

export function CustomFieldInput({
  field,
  value,
  onCommit,
  size = "sm",
}: {
  field: Doc<"customFields">;
  value: FieldValue | undefined;
  onCommit: (value: FieldValue | null) => void;
  size?: "sm" | "md";
}) {
  const cls =
    size === "sm"
      ? "rounded-full border border-border bg-background px-2 py-1 text-xs"
      : "w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm";

  switch (field.type) {
    case "text":
      return (
        <DebouncedText
          initial={value?.textValue ?? ""}
          onCommit={(v) => onCommit(v === "" ? null : { textValue: v })}
          className={cls}
        />
      );
    case "number":
      return (
        <DebouncedText
          initial={value?.numberValue?.toString() ?? ""}
          onCommit={(v) => {
            if (v === "") return onCommit(null);
            const n = Number(v);
            if (!Number.isFinite(n)) return;
            onCommit({ numberValue: n });
          }}
          className={cls}
          inputMode="decimal"
        />
      );
    case "checkbox":
      return (
        <input
          type="checkbox"
          checked={!!value?.booleanValue}
          onChange={(e) => onCommit({ booleanValue: e.currentTarget.checked })}
          className="h-4 w-4 rounded border-border accent-[var(--color-foreground)]"
        />
      );
    case "date":
      return (
        <input
          type="date"
          value={value?.dateValue ? toDateInputValue(value.dateValue) : ""}
          onChange={(e) => {
            const ts = fromDateInputValue(e.currentTarget.value);
            onCommit(ts !== undefined ? { dateValue: ts } : null);
          }}
          className={cls}
        />
      );
    case "dropdown":
      return (
        <select
          value={value?.textValue ?? ""}
          onChange={(e) => {
            const v = e.currentTarget.value;
            onCommit(v ? { textValue: v } : null);
          }}
          className={cls}
        >
          <option value="">-</option>
          {(field.options ?? []).map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
        </select>
      );
  }
}

function DebouncedText({
  initial,
  onCommit,
  className,
  inputMode,
}: {
  initial: string;
  onCommit: (value: string) => void;
  className: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
}) {
  const [draft, setDraft] = useState(initial);
  useEffect(() => setDraft(initial), [initial]);

  return (
    <input
      type="text"
      inputMode={inputMode}
      value={draft}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onBlur={() => {
        if (draft !== initial) onCommit(draft);
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
