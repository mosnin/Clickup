import { httpRouter } from "convex/server";
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

const http = httpRouter();
http.route({ path: "/clerk", method: "POST", handler: handleClerkWebhook });
export default http;
