"use node";

import { v } from "convex/values";
import { Resend } from "resend";
import { internalAction } from "./_generated/server";

// Outbound email notifications. Triggered by ctx.scheduler from messages.ts
// (mentions) and tasks.ts (assignments). Each function is "best effort":
// any failure is logged and swallowed so a flaky email provider never
// breaks the originating mutation's transaction.
//
// Set RESEND_API_KEY and RESEND_FROM_EMAIL on the Convex deployment via
//   npx convex env set RESEND_API_KEY re_...
//   npx convex env set RESEND_FROM_EMAIL "ClickUp Clone <noreply@your.com>"
// Both are read at action invocation time, so missing env vars cause a
// no-op rather than a hard crash.

function makeResend(): {
  client: Resend;
  from: string;
} | null {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!key || !from) {
    console.warn(
      "[notifications] RESEND_API_KEY or RESEND_FROM_EMAIL not set; skipping email send",
    );
    return null;
  }
  return { client: new Resend(key), from };
}

export const sendMentionEmail = internalAction({
  args: {
    toEmail: v.string(),
    toName: v.optional(v.string()),
    fromName: v.string(),
    snippet: v.string(),
    contextLabel: v.string(),
  },
  handler: async (_, args) => {
    const provider = makeResend();
    if (!provider) return;
    try {
      await provider.client.emails.send({
        from: provider.from,
        to: [args.toEmail],
        subject: `${args.fromName} mentioned you in ${args.contextLabel}`,
        text: [
          `Hi ${args.toName ?? ""},`.trim(),
          ``,
          `${args.fromName} mentioned you:`,
          ``,
          args.snippet,
          ``,
          `Open ClickUp Clone to reply.`,
        ].join("\n"),
      });
    } catch (err) {
      console.warn("[notifications] sendMentionEmail failed:", err);
    }
  },
});

export const sendAssignmentEmail = internalAction({
  args: {
    toEmail: v.string(),
    toName: v.optional(v.string()),
    fromName: v.string(),
    taskTitle: v.string(),
  },
  handler: async (_, args) => {
    const provider = makeResend();
    if (!provider) return;
    try {
      await provider.client.emails.send({
        from: provider.from,
        to: [args.toEmail],
        subject: `${args.fromName} assigned a task to you`,
        text: [
          `Hi ${args.toName ?? ""},`.trim(),
          ``,
          `${args.fromName} assigned you to:`,
          ``,
          `  ${args.taskTitle}`,
          ``,
          `Open ClickUp Clone to view it.`,
        ].join("\n"),
      });
    } catch (err) {
      console.warn("[notifications] sendAssignmentEmail failed:", err);
    }
  },
});

// Direct push to an agent's notifyUrl: a small unsigned JSON ping telling
// the agent's runtime "you were assigned / mentioned — connect over MCP
// and look". Best effort, no retries: the webhook subscription system is
// the reliable channel; this is the zero-setup default.
export const postAgentPing = internalAction({
  args: {
    url: v.string(),
    type: v.string(),
    payload: v.any(),
  },
  handler: async (_, args) => {
    try {
      const res = await fetch(args.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: args.type, payload: args.payload }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        console.warn("[notifications] postAgentPing failed:", res.status);
      }
    } catch (err) {
      console.warn("[notifications] postAgentPing error:", err);
    }
  },
});

// Outbound Slack post via incoming webhook. Webhook URL is read from the
// integration row by tasks.ts and passed in here, so this action stays
// independent of the data model.
export const postSlack = internalAction({
  args: {
    webhookUrl: v.string(),
    text: v.string(),
  },
  handler: async (_, args) => {
    try {
      const res = await fetch(args.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: args.text }),
      });
      if (!res.ok) {
        console.warn(
          "[notifications] postSlack failed:",
          res.status,
          await res.text(),
        );
      }
    } catch (err) {
      console.warn("[notifications] postSlack error:", err);
    }
  },
});
