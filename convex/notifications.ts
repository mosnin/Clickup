"use node";

import { v } from "convex/values";
import { Resend } from "resend";
import { internalAction } from "./_generated/server";
import { reportActionError } from "./_sentry";

// Outbound email notifications. Triggered by ctx.scheduler from messages.ts
// (mentions) and tasks.ts (assignments). Each function is "best effort":
// any failure is logged and swallowed so a flaky email provider never
// breaks the originating mutation's transaction.
//
// Set RESEND_API_KEY and RESEND_FROM_EMAIL on the Convex deployment via
//   npx convex env set RESEND_API_KEY re_...
//   npx convex env set RESEND_FROM_EMAIL "operate.to <noreply@operate.to>"
// Both are read at action invocation time, so missing env vars cause a
// no-op rather than a hard crash.

function makeResend(): {
  client: Resend;
  from: string;
} | null {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  // Email is optional in local/test deployments. A quiet no-op keeps
  // scheduled actions from flooding logs or outliving a test environment.
  if (!key || !from) return null;
  return { client: new Resend(key), from };
}

export const sendInviteEmail = internalAction({
  args: {
    toEmail: v.string(),
    fromName: v.string(),
    workspaceName: v.string(),
    token: v.string(),
  },
  handler: async (_, args) => {
    const provider = makeResend();
    if (!provider) return;
    const base = process.env.NEXT_PUBLIC_APP_URL ?? "https://operate.to";
    try {
      await provider.client.emails.send({
        from: provider.from,
        to: [args.toEmail],
        subject: `${args.fromName} invited you to ${args.workspaceName} on operate.to`,
        text: [
          `${args.fromName} invited you to join "${args.workspaceName}" on operate.to.`,
          ``,
          `Accept your invite:`,
          `${base}/invite/${args.token}`,
          ``,
          `operate.to: mission control for humans and AI agents.`,
        ].join("\n"),
      });
    } catch (err) {
      reportActionError(err, { action: "sendInviteEmail" });
    }
  },
});

export const sendDueSoonEmail = internalAction({
  args: {
    toEmail: v.string(),
    toName: v.optional(v.string()),
    taskTitle: v.string(),
    whenLabel: v.string(),
  },
  handler: async (_, args) => {
    const provider = makeResend();
    if (!provider) return;
    try {
      await provider.client.emails.send({
        from: provider.from,
        to: [args.toEmail],
        subject: `Due ${args.whenLabel}: ${args.taskTitle}`,
        text: [
          `Hi ${args.toName ?? ""},`.trim(),
          ``,
          `A task assigned to you is due ${args.whenLabel}:`,
          ``,
          args.taskTitle,
          ``,
          `Open operate.to to work on it.`,
        ].join("\n"),
      });
    } catch (err) {
      reportActionError(err, { action: "sendDueSoonEmail" });
    }
  },
});

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
          `Open operate.to to reply.`,
        ].join("\n"),
      });
    } catch (err) {
      reportActionError(err, { action: "sendMentionEmail" });
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
          `Open operate.to to view it.`,
        ].join("\n"),
      });
    } catch (err) {
      reportActionError(err, { action: "sendAssignmentEmail" });
    }
  },
});

// Email a human that an agent finished work and is waiting on their
// approval. Scheduled from agentApi.requestApproval.
export const sendApprovalEmail = internalAction({
  args: {
    toEmail: v.string(),
    toName: v.optional(v.string()),
    agentName: v.string(),
    taskTitle: v.string(),
    note: v.optional(v.string()),
  },
  handler: async (_, args) => {
    const provider = makeResend();
    if (!provider) return;
    try {
      await provider.client.emails.send({
        from: provider.from,
        to: [args.toEmail],
        subject: `${args.agentName} needs your approval: ${args.taskTitle}`,
        text: [
          `Hi ${args.toName ?? ""},`.trim(),
          ``,
          `${args.agentName} finished work on "${args.taskTitle}" and is waiting for your approval before completing it.`,
          ...(args.note ? [``, args.note] : []),
          ``,
          `Approve it from your Inbox or the task page.`,
        ].join("\n"),
      });
    } catch (err) {
      reportActionError(err, { action: "sendApprovalEmail" });
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
      reportActionError(err, { action: "postSlack" });
    }
  },
});
