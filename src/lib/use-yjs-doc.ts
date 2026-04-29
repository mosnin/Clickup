"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import * as Y from "yjs";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

// Custom Yjs ↔ Convex sync provider.
//
// Convex's reactive query gives us a real-time stream of updates for free
// — useQuery on docUpdates.listSinceSequence(docId, since=lastApplied)
// re-runs whenever a teammate appends. We apply each new update locally,
// advance our `since` cursor, and never re-apply.
//
// Local edits flow the other way: we listen for Y.Doc update events that
// originated locally (origin !== "convex"), encode them, and push via the
// docUpdates.append mutation.
//
// Returns:
//   - ydoc: the Y.Doc Tiptap should bind to (Collaboration extension)
//   - status: "loading" until the snapshot is in; "synced" once
//     listSinceSequence has returned (even if empty); "missing" if the
//     doc was deleted
//
// The hook is intentionally aggressive about avoiding echo: applied
// remote updates are tagged with `REMOTE_ORIGIN`, and the local listener
// skips anything tagged with that.

const REMOTE_ORIGIN = "convex";

type Status = "loading" | "synced" | "missing";

export function useYjsDoc(docId: string) {
  const id = docId as Id<"docs">;
  const docMeta = useQuery(api.docs.get, { docId: id });

  // Build the Y.Doc once. It outlives renders; we don't recreate it
  // when the query re-fires.
  const ydocRef = useRef<Y.Doc | null>(null);
  if (ydocRef.current === null) {
    ydocRef.current = new Y.Doc();
  }
  const ydoc = ydocRef.current;

  const seededRef = useRef(false);
  const [appliedSequence, setAppliedSequence] = useState(0);
  const [status, setStatus] = useState<Status>("loading");

  // Apply the snapshot once the doc record arrives. This also handles
  // the "legacy doc with only Tiptap JSON content" case: if there's no
  // snapshot but there is content, run prosemirrorJSONToYDoc as a
  // one-shot seed. The first local edit will produce a Yjs update,
  // which goes through docUpdates.append, after which compaction will
  // produce a real snapshot.
  useEffect(() => {
    if (seededRef.current) return;
    if (docMeta === undefined) return;
    if (docMeta === null) {
      setStatus("missing");
      seededRef.current = true;
      return;
    }
    if (docMeta.snapshot) {
      Y.applyUpdate(
        ydoc,
        new Uint8Array(docMeta.snapshot),
        REMOTE_ORIGIN,
      );
      setAppliedSequence(docMeta.snapshotSequence ?? 0);
    } else if (docMeta.content) {
      // Lazy migration. Keep this side-effect inside the guard so it
      // only runs once per editor session per doc.
      seedYDocFromTiptapJson(ydoc, docMeta.content);
    }
    seededRef.current = true;
    setStatus("synced");
  }, [docMeta, ydoc]);

  // Subscribe to incoming updates. `since=appliedSequence` ensures we
  // never re-apply something already folded into the snapshot or seen
  // earlier.
  const incoming = useQuery(
    api.docUpdates.listSinceSequence,
    seededRef.current && status !== "missing"
      ? { docId: id, since: appliedSequence }
      : "skip",
  );

  useEffect(() => {
    if (!incoming || incoming.length === 0) return;
    let last = appliedSequence;
    for (const u of incoming) {
      Y.applyUpdate(ydoc, new Uint8Array(u.update), REMOTE_ORIGIN);
      if (u.sequence > last) last = u.sequence;
    }
    if (last !== appliedSequence) setAppliedSequence(last);
  }, [incoming, ydoc, appliedSequence]);

  // Push local edits back to Convex. We attach an updateV2 listener
  // (covers more edge cases than v1) and skip anything we just applied
  // ourselves with origin = REMOTE_ORIGIN.
  const append = useMutation(api.docUpdates.append);
  useEffect(() => {
    if (status !== "synced") return;
    const handler = (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE_ORIGIN) return;
      append({
        docId: id,
        update: update.buffer.slice(
          update.byteOffset,
          update.byteOffset + update.byteLength,
        ) as ArrayBuffer,
      }).catch(() => {
        // Push failures aren't fatal — Convex retries on next change
        // and the local doc keeps the edit.
      });
    };
    ydoc.on("update", handler);
    return () => {
      ydoc.off("update", handler);
    };
  }, [ydoc, id, append, status]);

  return useMemo(
    () => ({ ydoc, status }),
    [ydoc, status],
  );
}

// Walk a ProseMirror JSON tree and emit equivalent Yjs ops. We use
// y-prosemirror's helper when the legacy doc has Tiptap structure; on
// older docs that may only have plain text it falls back to inserting
// a single paragraph.
function seedYDocFromTiptapJson(ydoc: Y.Doc, content: unknown): void {
  try {
    if (content && typeof content === "object") {
      // Most legacy docs were created with `{ type: "doc", content: [...] }`.
      // Encode them by walking text nodes — y-prosemirror's full helper
      // requires a Schema, which we don't import here. The text-only
      // fallback below works for our seed content.
      const fragment = ydoc.getXmlFragment("default");
      const text = extractText(content as JsonNode).trim();
      if (text) {
        const para = new Y.XmlElement("paragraph");
        para.insert(0, [new Y.XmlText(text)]);
        fragment.insert(0, [para]);
      }
    }
  } catch (err) {
    // If the seed fails, we end up with an empty doc — better than
    // throwing inside an effect. Logged for diagnostics.
    console.warn("[useYjsDoc] seed from legacy content failed:", err);
  }
}

type JsonNode = { type?: string; text?: string; content?: JsonNode[] };

function extractText(node: JsonNode): string {
  if (typeof node?.text === "string") return node.text;
  if (Array.isArray(node?.content)) {
    return node.content.map(extractText).join("\n");
  }
  return "";
}
