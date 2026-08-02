import { anyApi, httpRouter } from "convex/server";
import type { FunctionReference } from "convex/server";
import { Webhook } from "svix";
import type { WebhookEvent } from "@clerk/backend";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

// Clerk -> Convex user sync.
//
// Configure a webhook in the Clerk dashboard pointing at:
//   https://<deployment>.convex.site/clerk
// (note `.convex.site`, not `.convex.cloud`)
// subscribed to user.created, user.updated, and user.deleted.
// Copy the signing secret into the Convex environment as CLERK_WEBHOOK_SECRET
// (set via `npx convex env set CLERK_WEBHOOK_SECRET ...`).
const handleClerkWebhook = httpAction(async (ctx, request) => {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    return new Response("CLERK_WEBHOOK_SECRET not configured", { status: 500 });
  }

  const svixId = request.headers.get("svix-id");
  const svixTimestamp = request.headers.get("svix-timestamp");
  const svixSignature = request.headers.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) {
    return new Response("Missing svix headers", { status: 400 });
  }

  const body = await request.text();
  const wh = new Webhook(secret);
  let evt: WebhookEvent;
  try {
    evt = wh.verify(body, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as WebhookEvent;
  } catch {
    return new Response("Invalid signature", { status: 400 });
  }

  switch (evt.type) {
    case "user.created":
    case "user.updated": {
      const primaryEmail = evt.data.email_addresses.find(
        (e) => e.id === evt.data.primary_email_address_id,
      )?.email_address;
      const name =
        [evt.data.first_name, evt.data.last_name].filter(Boolean).join(" ") ||
        undefined;
      await ctx.runMutation(internal.users.upsertFromClerk, {
        clerkId: evt.data.id,
        email: primaryEmail ?? "",
        name,
        imageUrl: evt.data.image_url,
      });
      break;
    }
    case "user.deleted": {
      if (evt.data.id) {
        await ctx.runMutation(internal.users.deleteFromClerk, {
          clerkId: evt.data.id,
        });
      }
      break;
    }
  }

  return new Response("ok", { status: 200 });
});

// ---------------------------------------------------------------------------
// Chat workflows: the webhook trigger door.
// ---------------------------------------------------------------------------

/**
 * `POST /hooks/<scopeType>/<scopeId>/<workflowId>`
 *
 * Buzz's route is `/hooks/{id}` because its relay resolves a workflow from a
 * single table. Ours cannot: every index in `convex/buzz/workflows.ts` leads
 * with the community, which is the tenancy fence, and a lookup by id alone
 * would need a scope-blind index — the one thing that makes the fence skippable
 * rather than unskippable. So the community is in the path. It is not a secret
 * (it is in every application URL already); the secret is the secret.
 *
 * The workflow's secret arrives in `X-Webhook-Secret`, not the body, so a
 * misconfigured sender cannot log it into somebody's message history by posting
 * it as content. It is compared in constant time inside the mutation.
 *
 * Every failure answers 404 with the same body. A 401 for a bad secret and a
 * 404 for a missing workflow would let anyone enumerate which workflow ids
 * exist by watching which status they get — the same reason the queue withholds
 * a report whole rather than redacting it.
 */
const fireWorkflowWebhook = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean); // ["hooks", type, id, workflowId]
  const [, scopeType, scopeId, workflowId] = parts;

  if ((scopeType !== "user" && scopeType !== "workspace") || !scopeId || !workflowId) {
    return new Response("not found", { status: 404 });
  }

  const secret = request.headers.get("x-webhook-secret") ?? "";
  if (!secret) return new Response("not found", { status: 404 });

  // Bounded, because this endpoint is unauthenticated until the secret is
  // checked and the body is read before that check can happen.
  const raw = await request.text();
  if (raw.length > 64 * 1024) return new Response("not found", { status: 404 });

  let body: unknown = undefined;
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      // A non-JSON body is not an error: a workflow may only care that it fired.
      body = { raw };
    }
  }

  const result = (await ctx.runMutation(fireWebhookRef, {
    scopeType,
    scopeId,
    workflowId,
    secret,
    body,
  })) as { status: string; runId?: string };

  if (result.status !== "accepted") return new Response("not found", { status: 404 });
  return new Response(JSON.stringify({ status: "accepted", runId: result.runId }), {
    status: 202,
    headers: { "content-type": "application/json" },
  });
});

/**
 * Reached through `anyApi` with a locally written type, because
 * `convex/_generated/` is the checked-in stub here and does not know
 * `internal.buzz.*` yet. Same device, and the same reason, as
 * `convex/buzz/keys.ts`. Delete the cast the first time the CLI regenerates.
 */
const fireWebhookRef = anyApi.buzz.workflows.fireWebhook as unknown as FunctionReference<
  "mutation",
  "internal",
  {
    scopeType: "user" | "workspace";
    scopeId: string;
    workflowId: string;
    secret: string;
    body?: unknown;
  },
  { status: string; runId?: string; workflowId?: string }
>;

const http = httpRouter();
http.route({ path: "/clerk", method: "POST", handler: handleClerkWebhook });
// pathPrefix, because the community and the workflow id are path segments.
http.route({ pathPrefix: "/hooks/", method: "POST", handler: fireWorkflowWebhook });
export default http;
