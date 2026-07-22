"use client";

import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { AnimatePresence, EASE, motion } from "@/components/motion";

// Creating a second workspace is one field, not a ceremony. (First-run
// onboarding stays reserved for first-run.) Portaled to <body> because
// triggers live inside the transformed sidebar.

export function NewWorkspaceDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const create = useMutation(api.workspaces.create);
  const createSpace = useMutation(api.spaces.create);
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n || pending) return;
    setPending(true);
    try {
      const workspaceId = await create({ name: n });
      // A workspace needs one space to be usable; seed "HQ" quietly.
      await createSpace({
        name: "HQ",
        parentType: "workspace",
        parentId: workspaceId,
      });
      setName("");
      onClose();
      router.push(`/dashboard/w/${workspaceId}`);
    } finally {
      setPending(false);
    }
  }

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[70] flex items-start justify-center bg-foreground/30 p-4 pt-[18vh] backdrop-blur-sm"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <motion.form
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.25, ease: EASE }}
            onSubmit={submit}
            className="panel w-full max-w-sm rounded-2xl p-6"
            role="dialog"
            aria-label="New workspace"
          >
            <h2 className="text-lg font-semibold tracking-tight">
              New workspace
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              A shared home for a team and its agents. You can invite people
              from its settings.
            </p>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder="Workspace name"
              aria-label="Workspace name"
              className="soft-field mt-4 w-full px-3.5 py-2.5 text-sm"
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!name.trim() || pending}>
                {pending ? "Creating…" : "Create workspace"}
              </Button>
            </div>
          </motion.form>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
