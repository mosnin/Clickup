"use client";

import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeft, Upload, X } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { AnimatePresence, EASE, motion } from "@/components/motion";

// Bring tasks in from a CSV (ClickUp exports or any generic CSV) into a
// chosen list. Three steps: pick the destination list, upload + map CSV
// columns to task fields, then preview and import in batches. Parsing
// happens entirely client-side — the server only ever sees already-shaped
// rows (see convex/importer.ts).

// ── Hand-rolled CSV parser ──────────────────────────────────────────────
// Handles quoted fields (commas/newlines inside quotes) and escaped quotes
// (""), which a naive text.split(",") can't. No external dependency.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;
  while (i < len) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += char;
      i++;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (char === "\r") {
      i++;
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += char;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

// Guess which CSV column maps to a task field by looking for a header
// containing one of a few common substrings, in priority order.
function guessColumn(headers: string[], candidates: string[]): number | null {
  const lower = headers.map((h) => h.trim().toLowerCase());
  for (const candidate of candidates) {
    const idx = lower.findIndex((h) => h.includes(candidate));
    if (idx !== -1) return idx;
  }
  return null;
}

type Mapping = {
  title: number | null;
  description: number | null;
  priority: number | null;
  dueDate: number | null;
  statusName: number | null;
};

type MappedRow = {
  title: string;
  description?: string;
  priority?: string;
  dueDate?: number;
  statusName?: string;
};

const BATCH_SIZE = 200;

type ListOption = { id: Id<"lists">; name: string; place: string };

export function ImportDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const tree = useQuery(api.sidebar.tree, open ? {} : "skip");
  const importTasks = useMutation(api.importer.importTasks);

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [listSearch, setListSearch] = useState("");
  const [selectedList, setSelectedList] = useState<ListOption | null>(null);

  const [fileName, setFileName] = useState<string | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[] | null>(null);
  const [csvRows, setCsvRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Mapping>({
    title: null,
    description: null,
    priority: null,
    dueDate: null,
    statusName: null,
  });

  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{
    created: number;
    skipped: number;
    unmatchedStatusCount: number;
    unmatchedStatusNames: string[];
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function reset() {
    setStep(1);
    setListSearch("");
    setSelectedList(null);
    setFileName(null);
    setCsvHeaders(null);
    setCsvRows([]);
    setMapping({
      title: null,
      description: null,
      priority: null,
      dueDate: null,
      statusName: null,
    });
    setImporting(false);
    setResult(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") handleClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Every list in the tree — same walk the ⌘K palette uses.
  const allLists = useMemo<ListOption[]>(() => {
    if (!tree) return [];
    const out: ListOption[] = [];
    const spaces = [
      ...(tree.personal ? [{ space: tree.personal, place: "Personal" }] : []),
      ...tree.workspaces.flatMap((w) =>
        w.spaces.map((s) => ({ space: s, place: w.name })),
      ),
    ];
    for (const { space, place } of spaces) {
      for (const l of space.lists) {
        out.push({ id: l._id, name: l.name, place: `${place} · ${space.name}` });
      }
      for (const f of space.folders) {
        for (const l of f.lists) {
          out.push({ id: l._id, name: l.name, place: `${place} · ${f.name}` });
        }
      }
    }
    return out;
  }, [tree]);

  const filteredLists = useMemo(() => {
    const q = listSearch.trim().toLowerCase();
    if (!q) return allLists;
    return allLists.filter((l) => l.name.toLowerCase().includes(q));
  }, [allLists, listSearch]);

  function onFileChosen(file: File) {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      const rows = parseCsv(text);
      if (rows.length < 2) {
        toast("That CSV has no data rows", { kind: "error" });
        setFileName(null);
        return;
      }
      const [headerRow, ...dataRows] = rows;
      const headers = headerRow.map((h) => h.trim());
      setCsvHeaders(headers);
      setCsvRows(dataRows);
      setMapping({
        title: guessColumn(headers, ["task name", "name", "title"]),
        description: guessColumn(headers, ["description", "content", "notes"]),
        priority: guessColumn(headers, ["priority"]),
        dueDate: guessColumn(headers, ["due date", "due"]),
        statusName: guessColumn(headers, ["status"]),
      });
    };
    reader.onerror = () => {
      toast("Couldn't read that file", { kind: "error" });
      setFileName(null);
    };
    reader.readAsText(file);
  }

  const mappedRows = useMemo<MappedRow[]>(() => {
    if (!csvHeaders || mapping.title === null) return [];
    const get = (row: string[], idx: number | null) =>
      idx === null ? undefined : row[idx]?.trim() || undefined;
    const out: MappedRow[] = [];
    for (const row of csvRows) {
      const title = get(row, mapping.title);
      if (!title) continue;
      const rawDue = get(row, mapping.dueDate);
      const dueMs = rawDue ? new Date(rawDue).getTime() : NaN;
      out.push({
        title,
        description: get(row, mapping.description),
        priority: get(row, mapping.priority),
        dueDate: Number.isFinite(dueMs) ? dueMs : undefined,
        statusName: get(row, mapping.statusName),
      });
    }
    return out;
  }, [csvHeaders, csvRows, mapping]);

  async function runImport() {
    if (!selectedList || mappedRows.length === 0) return;
    setImporting(true);
    let created = 0;
    let skipped = 0;
    let unmatchedStatusCount = 0;
    const unmatchedStatusNames = new Set<string>();
    try {
      for (let i = 0; i < mappedRows.length; i += BATCH_SIZE) {
        const batch = mappedRows.slice(i, i + BATCH_SIZE);
        const res = await importTasks({ listId: selectedList.id, rows: batch });
        created += res.created;
        skipped += res.skipped;
        unmatchedStatusCount += res.unmatchedStatusCount;
        for (const name of res.unmatchedStatusNames) {
          unmatchedStatusNames.add(name);
        }
      }
      setResult({
        created,
        skipped,
        unmatchedStatusCount,
        unmatchedStatusNames: Array.from(unmatchedStatusNames).slice(0, 5),
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      toast(
        raw.split("Uncaught Error:").pop()?.split("\n")[0]?.trim() ||
          "Import failed",
        { kind: "error" },
      );
    } finally {
      setImporting(false);
    }
  }

  if (!mounted) return null;

  const fieldLabels: { key: keyof Mapping; label: string; required?: boolean }[] = [
    { key: "title", label: "Title", required: true },
    { key: "description", label: "Description" },
    { key: "priority", label: "Priority" },
    { key: "dueDate", label: "Due date" },
    { key: "statusName", label: "Status" },
  ];

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[70] flex items-start justify-center bg-black/30 p-4 pt-[10vh] backdrop-blur-sm"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) handleClose();
          }}
        >
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.25, ease: EASE }}
            className="panel max-h-[76vh] w-full max-w-lg overflow-y-auto rounded-2xl p-6"
            role="dialog"
            aria-label="Import from CSV"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">
                  Import from CSV
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Bring work in from ClickUp or any CSV export.
                </p>
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={handleClose}
                className="tap-target inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {result ? (
              <div className="mt-6 space-y-4">
                <p className="text-sm">
                  Imported <span className="font-semibold">{result.created}</span>{" "}
                  task{result.created === 1 ? "" : "s"}
                  {result.skipped > 0
                    ? ` (${result.skipped} row${result.skipped === 1 ? "" : "s"} skipped — blank title).`
                    : "."}
                </p>
                {result.unmatchedStatusCount > 0 && (
                  <p className="text-sm text-muted-foreground">
                    {result.unmatchedStatusCount} task
                    {result.unmatchedStatusCount === 1 ? "" : "s"} had
                    unrecognized statuses and used the default
                    {result.unmatchedStatusNames.length > 0
                      ? ` (${result.unmatchedStatusNames.join(", ")}${
                          result.unmatchedStatusNames.length >= 5 ? ", …" : ""
                        }).`
                      : "."}
                  </p>
                )}
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={handleClose}>
                    Close
                  </Button>
                  {selectedList && (
                    <Link href={`/dashboard/l/${selectedList.id}`}>
                      <Button size="sm" onClick={handleClose}>
                        View list
                      </Button>
                    </Link>
                  )}
                </div>
              </div>
            ) : (
              <>
                {step === 1 && (
                  <div className="mt-5 space-y-3">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Step 1 · Destination list
                    </p>
                    <input
                      autoFocus
                      value={listSearch}
                      onChange={(e) => setListSearch(e.currentTarget.value)}
                      placeholder="Search lists…"
                      className="soft-field w-full px-3.5 py-2.5 text-sm"
                    />
                    <div className="max-h-64 space-y-1 overflow-y-auto">
                      {tree === undefined ? (
                        <div className="h-24 animate-pulse rounded-xl bg-muted/40" />
                      ) : filteredLists.length === 0 ? (
                        <p className="px-1 py-6 text-center text-sm text-muted-foreground">
                          No lists match.
                        </p>
                      ) : (
                        filteredLists.map((l) => (
                          <button
                            key={l.id}
                            type="button"
                            onClick={() => {
                              setSelectedList(l);
                              setStep(2);
                            }}
                            className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted"
                          >
                            <span className="truncate font-medium">{l.name}</span>
                            <span className="flex-shrink-0 truncate text-xs text-muted-foreground">
                              {l.place}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                )}

                {step === 2 && selectedList && (
                  <div className="mt-5 space-y-4">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setStep(1)}
                        className="tap-target inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                        aria-label="Back"
                      >
                        <ArrowLeft className="h-3.5 w-3.5" />
                      </button>
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Step 2 · Upload & map columns · into {selectedList.name}
                      </p>
                    </div>

                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".csv,text/csv"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.currentTarget.files?.[0];
                        if (file) onFileChosen(file);
                        e.currentTarget.value = "";
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="soft-field flex w-full items-center justify-center gap-2 px-3.5 py-4 text-sm text-muted-foreground hover:text-foreground"
                    >
                      <Upload className="h-4 w-4" />
                      {fileName ?? "Choose a .csv file…"}
                    </button>

                    {csvHeaders && (
                      <div className="space-y-2">
                        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          Map columns
                        </p>
                        {fieldLabels.map(({ key, label, required }) => (
                          <div
                            key={key}
                            className="flex items-center justify-between gap-3"
                          >
                            <label className="text-sm text-muted-foreground">
                              {label}
                              {required && " *"}
                            </label>
                            <select
                              value={mapping[key] ?? ""}
                              onChange={(e) =>
                                setMapping((m) => ({
                                  ...m,
                                  [key]:
                                    e.currentTarget.value === ""
                                      ? null
                                      : Number(e.currentTarget.value),
                                }))
                              }
                              className="soft-field w-48 px-2.5 py-1.5 text-sm"
                            >
                              {!required && <option value="">None</option>}
                              {csvHeaders.map((h, idx) => (
                                <option key={idx} value={idx}>
                                  {h || `Column ${idx + 1}`}
                                </option>
                              ))}
                            </select>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={handleClose}>
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        disabled={mapping.title === null || mappedRows.length === 0}
                        onClick={() => setStep(3)}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}

                {step === 3 && selectedList && (
                  <div className="mt-5 space-y-4">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setStep(2)}
                        className="tap-target inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                        aria-label="Back"
                      >
                        <ArrowLeft className="h-3.5 w-3.5" />
                      </button>
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Step 3 · Preview · {mappedRows.length} row
                        {mappedRows.length === 1 ? "" : "s"}
                      </p>
                    </div>

                    <div className="overflow-x-auto rounded-xl bento-tile">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="text-muted-foreground">
                            <th className="px-3 py-2 font-medium">Title</th>
                            <th className="px-3 py-2 font-medium">Priority</th>
                            <th className="px-3 py-2 font-medium">Due</th>
                            <th className="px-3 py-2 font-medium">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {mappedRows.slice(0, 5).map((r, i) => (
                            <tr key={i} className="border-t border-border/60">
                              <td className="max-w-[180px] truncate px-3 py-2">
                                {r.title}
                              </td>
                              <td className="px-3 py-2">{r.priority ?? "—"}</td>
                              <td className="px-3 py-2">
                                {r.dueDate
                                  ? new Date(r.dueDate).toLocaleDateString()
                                  : "—"}
                              </td>
                              <td className="px-3 py-2">{r.statusName ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={handleClose}>
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        disabled={importing || mappedRows.length === 0}
                        onClick={runImport}
                      >
                        {importing
                          ? "Importing…"
                          : `Import ${mappedRows.length} task${mappedRows.length === 1 ? "" : "s"}`}
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
