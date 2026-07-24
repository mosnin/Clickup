import type { Doc } from "@convex/_generated/dataModel";

// Client-side metadata for the custom-field system: what each type is
// called, which group it belongs to in the picker, what to say about it,
// and how to render a value as text. The server's rules live in
// convex/_customFields.ts — this file is presentation only, and the shared
// `FieldType` union keeps the two exhaustive together (adding a type to the
// schema breaks this file until it's described here).

export type FieldType = Doc<"customFields">["type"];
export type FieldConfig = NonNullable<Doc<"customFields">["config"]>;
export type FieldOption = { id: string; label: string; color?: string };

export type FieldGroup = "basic" | "numeric" | "contact" | "relational" | "computed";

export const FIELD_GROUPS: { id: FieldGroup; label: string }[] = [
  { id: "basic", label: "Basic" },
  { id: "numeric", label: "Numeric" },
  { id: "contact", label: "Contact" },
  { id: "relational", label: "Relational" },
  { id: "computed", label: "Computed" },
];

export type FieldTypeMeta = {
  type: FieldType;
  label: string;
  group: FieldGroup;
  /** One line, sentence case, for the tile. */
  blurb: string;
  /** Extra search terms so "multi select" finds Labels. */
  keywords: string[];
};

export const FIELD_TYPES: FieldTypeMeta[] = [
  {
    type: "text",
    label: "Text",
    group: "basic",
    blurb: "A single line of free text.",
    keywords: ["string", "line", "name"],
  },
  {
    type: "long_text",
    label: "Long text",
    group: "basic",
    blurb: "A paragraph that grows with what you write.",
    keywords: ["paragraph", "notes", "description", "textarea"],
  },
  {
    type: "dropdown",
    label: "Dropdown",
    group: "basic",
    blurb: "Pick exactly one of your options.",
    keywords: ["select", "single", "choice", "picklist"],
  },
  {
    type: "labels",
    label: "Labels",
    group: "basic",
    blurb: "Pick as many options as apply.",
    keywords: ["multi select", "tags", "chips", "multiple"],
  },
  {
    type: "date",
    label: "Date",
    group: "basic",
    blurb: "A calendar day.",
    keywords: ["calendar", "day", "deadline"],
  },
  {
    type: "checkbox",
    label: "Checkbox",
    group: "basic",
    blurb: "A yes or no you can tick.",
    keywords: ["boolean", "toggle", "yes no", "flag"],
  },
  {
    type: "files",
    label: "Files",
    group: "basic",
    blurb: "Drop attachments straight onto the field.",
    keywords: ["upload", "attachment", "document", "image"],
  },
  {
    type: "number",
    label: "Number",
    group: "numeric",
    blurb: "Any number, with optional bounds and decimals.",
    keywords: ["integer", "decimal", "quantity", "count"],
  },
  {
    type: "money",
    label: "Money",
    group: "numeric",
    blurb: "An amount with a currency.",
    keywords: ["currency", "price", "cost", "budget", "usd"],
  },
  {
    type: "rating",
    label: "Rating",
    group: "numeric",
    blurb: "Stars, from one to however many you allow.",
    keywords: ["stars", "score", "quality", "five"],
  },
  {
    type: "progress",
    label: "Progress",
    group: "numeric",
    blurb: "A percentage you drag from 0 to 100.",
    keywords: ["percent", "bar", "completion", "slider"],
  },
  {
    type: "voting",
    label: "Voting",
    group: "numeric",
    blurb: "Everyone upvotes; the field counts them.",
    keywords: ["upvote", "poll", "priority", "demand"],
  },
  {
    type: "email",
    label: "Email",
    group: "contact",
    blurb: "A validated address that opens your mail client.",
    keywords: ["mail", "address", "contact"],
  },
  {
    type: "phone",
    label: "Phone",
    group: "contact",
    blurb: "A number that dials on mobile.",
    keywords: ["tel", "mobile", "call", "number"],
  },
  {
    type: "url",
    label: "Website",
    group: "contact",
    blurb: "A link, checked before it's saved.",
    keywords: ["link", "url", "site", "http"],
  },
  {
    type: "location",
    label: "Location",
    group: "contact",
    blurb: "A place, optionally with coordinates.",
    keywords: ["address", "place", "map", "lat", "lng", "geo"],
  },
  {
    type: "people",
    label: "People",
    group: "relational",
    blurb: "Teammates and agents, picked like assignees.",
    keywords: ["person", "user", "assignee", "agent", "owner", "member"],
  },
  {
    type: "relationship",
    label: "Relationship",
    group: "relational",
    blurb: "Links to other tasks.",
    keywords: ["link", "related", "reference", "task", "dependency"],
  },
  {
    type: "rollup",
    label: "Rollup",
    group: "computed",
    blurb: "Sums, averages, or counts values from linked work.",
    keywords: ["sum", "average", "count", "aggregate", "derive"],
  },
  {
    type: "formula",
    label: "Formula",
    group: "computed",
    blurb: "Arithmetic over this list's other numeric fields.",
    keywords: ["calculate", "expression", "math", "compute"],
  },
];

export const FIELD_TYPE_META: Record<FieldType, FieldTypeMeta> =
  FIELD_TYPES.reduce(
    (acc, meta) => {
      acc[meta.type] = meta;
      return acc;
    },
    {} as Record<FieldType, FieldTypeMeta>,
  );

export function fieldTypeLabel(type: FieldType): string {
  return FIELD_TYPE_META[type]?.label ?? type;
}

/** Computed types are derived on read and can never be written. */
export function isComputedType(type: FieldType): boolean {
  return type === "rollup" || type === "formula";
}

/** Types whose value is a number the computed types can read. */
export function isNumericType(type: FieldType): boolean {
  return (
    type === "number" ||
    type === "money" ||
    type === "rating" ||
    type === "progress" ||
    type === "voting" ||
    type === "rollup" ||
    type === "formula"
  );
}

export function usesOptions(type: FieldType): boolean {
  return type === "dropdown" || type === "labels";
}

/** The config a freshly-picked type should start with. */
export function defaultConfigFor(type: FieldType): FieldConfig | undefined {
  switch (type) {
    case "money":
      return { currency: "USD", precision: 2 };
    case "rating":
      return { ratingMax: 5 };
    case "formula":
      return { formula: "" };
    case "rollup":
      return { rollup: { source: "subtasks", op: "sum" } };
    default:
      return undefined;
  }
}

export const DEFAULT_OPTION_COLORS = [
  "#d9e8fa",
  "#e6defa",
  "#f9e0f4",
  "#faeec7",
  "#d5efde",
  "#fadcd7",
];

export function formatMoney(
  amount: number,
  currency: string | undefined,
): string {
  const code = (currency ?? "USD").toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    // An unknown code shouldn't blank the cell.
    return `${amount.toLocaleString()} ${code}`;
  }
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Rounds a computed number for display without lying about precision. */
export function formatComputed(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (Number.isInteger(value)) return value.toLocaleString();
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
