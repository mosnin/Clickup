"use client";

// Phase F stub — shared checklist primitives. ChecklistChip is the tiny
// "3/5" progress indicator rendered on task rows and board cards; the
// checklists workstream implements it (and may add more exports) without
// its consumers changing their imports.

export type ChecklistItem = { id: string; text: string; done: boolean };

export function ChecklistChip(props: { checklist?: ChecklistItem[] }) {
  void props;
  return null;
}
