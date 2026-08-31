"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Mail } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { AnimatePresence, motion, EASE } from "@/components/motion";

// Pending workspace invites addressed to the signed-in user's email, shown at
// the top of Home. Accept joins the workspace and navigates into it; decline
// dismisses. Both paths require the email to match (enforced server-side).

export function InviteCards() {
  const invites = useQuery(api.invites.listForCurrentUser, {});
  if (!invites || invites.length === 0) return null;

  return (
    <section aria-label="Pending invites">
      <AnimatePresence initial={false}>
        {invites.map((inv) => (
          <motion.div
            key={inv._id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, height: 0, marginBottom: 0 }}
            transition={{ duration: 0.4, ease: EASE }}
            className="mb-3 overflow-hidden"
          >
            <InviteCard
              inviteId={inv._id}
              workspaceName={inv.workspaceName}
              invitedBy={inv.invitedBy}
              role={inv.role}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </section>
  );
}

function InviteCard({
  inviteId,
  workspaceName,
  invitedBy,
  role,
}: {
  inviteId: Id<"invites">;
  workspaceName: string;
  invitedBy: string;
  role: string;
}) {
  const accept = useMutation(api.invites.accept);
  const decline = useMutation(api.invites.decline);
  const router = useRouter();
  const { toast } = useToast();
  const [pending, setPending] = useState(false);

  async function onAccept() {
    setPending(true);
    try {
      const { workspaceId } = await accept({ inviteId });
      toast(`Joined ${workspaceName}`);
      router.push(`/dashboard/w/${workspaceId}`);
    } catch (e) {
      toast(
        e instanceof Error
          ? e.message.split("Uncaught Error:").pop()?.split("\n")[0]?.trim() ||
              "Couldn't accept invite"
          : "Couldn't accept invite",
        { kind: "error" },
      );
      setPending(false);
    }
  }

  async function onDecline() {
    setPending(true);
    try {
      await decline({ inviteId });
    } catch (e) {
      toast(
        e instanceof Error
          ? e.message.split("Uncaught Error:").pop()?.split("\n")[0]?.trim() ||
              "Couldn't decline invite"
          : "Couldn't decline invite",
        { kind: "error" },
      );
      setPending(false);
    }
  }

  return (
    // Wrapping, because the three parts of this card have very different
    // rights to the space. On a phone the row had 88px left for the text after
    // the icon and the two buttons had taken theirs — and an email address is
    // one unbreakable word, so it painted straight out of its box and under
    // the Accept pill. `basis-56` is the width below which the sentence stops
    // being readable: past that the buttons drop to their own line rather than
    // the words being crushed, and `break-words` keeps a very long address
    // inside the card even then.
    <div className="flex flex-wrap items-center gap-3 rounded-full panel px-3 py-2">
      <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-muted">
        <Mail className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1 basis-40">
        <p className="truncate text-sm font-medium">
          Join {workspaceName}
          <span className="font-normal text-muted-foreground">
            {" "}
            · {invitedBy} invited you as {role}
          </span>
        </p>
      </div>
      <div className="flex flex-shrink-0 items-center gap-2">
        <Button type="button" size="sm" onClick={onAccept} disabled={pending}>
          {pending ? "Joining…" : "Accept"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={onDecline}
        >
          Decline
        </Button>
      </div>
    </div>
  );
}
