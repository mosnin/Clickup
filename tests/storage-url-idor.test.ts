import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

// pages.urlForUpload used to mint a signed URL for any storageId the
// caller named. clips.getUrl already refused that (clip → task → space).
// This file is the same rule on the page-image path: an orphan (just
// uploaded) is fine; a blob already attached to a task the caller cannot
// open is not.

const modules = import.meta.glob("../convex/**/*.*s");

const OWNER = { subject: "user_owner", email: "owner@acme.com" };
const OUTSIDER = { subject: "user_outsider", email: "outsider@acme.com" };

async function seed() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    for (const u of [OWNER, OUTSIDER]) {
      await ctx.db.insert("users", { clerkId: u.subject, email: u.email });
    }
  });
  return t;
}

async function makeTask(t: ReturnType<typeof convexTest>): Promise<Id<"tasks">> {
  const spaceId = await t.withIdentity(OWNER).mutation(api.spaces.create, {
    name: "Personal",
    parentType: "user",
    parentId: OWNER.subject,
  });
  const listId = await t.withIdentity(OWNER).mutation(api.lists.create, {
    name: "My list",
    parentType: "space",
    parentId: spaceId,
  });
  return await t.withIdentity(OWNER).mutation(api.tasks.create, {
    listId,
    title: "Attach stuff here",
  });
}

async function storeBlob(t: ReturnType<typeof convexTest>): Promise<Id<"_storage">> {
  return await t.run(async (ctx) => ctx.storage.store(new Blob(["hello world"])));
}

describe("pages.urlForUpload is not a storage IDOR", () => {
  it("returns a URL for a just-uploaded orphan", async () => {
    const t = await seed();
    const storageId = await storeBlob(t);
    const url = await t
      .withIdentity(OWNER)
      .mutation(api.pages.urlForUpload, { storageId });
    expect(typeof url).toBe("string");
    expect(url).toBeTruthy();
  });

  it("refuses an unauthenticated caller even for an orphan", async () => {
    const t = await seed();
    const storageId = await storeBlob(t);
    await expect(t.mutation(api.pages.urlForUpload, { storageId })).rejects.toThrow(
      /not authenticated/i,
    );
  });

  it("refuses a storageId that belongs to someone else's attachment", async () => {
    const t = await seed();
    const taskId = await makeTask(t);
    const storageId = await storeBlob(t);
    await t.withIdentity(OWNER).mutation(api.attachments.create, {
      taskId,
      storageId,
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 11,
    });

    await expect(
      t.withIdentity(OUTSIDER).mutation(api.pages.urlForUpload, { storageId }),
    ).rejects.toThrow(/forbidden/i);

    const url = await t
      .withIdentity(OWNER)
      .mutation(api.pages.urlForUpload, { storageId });
    expect(url).toBeTruthy();
  });

  it("refuses a storageId that belongs to someone else's clip", async () => {
    const t = await seed();
    const taskId = await makeTask(t);
    const storageId = await storeBlob(t);
    await t.withIdentity(OWNER).mutation(api.clips.create, {
      taskId,
      storageId,
      mimeType: "video/webm",
      sizeBytes: 11,
    });

    await expect(
      t.withIdentity(OUTSIDER).mutation(api.pages.urlForUpload, { storageId }),
    ).rejects.toThrow(/forbidden/i);

    const url = await t
      .withIdentity(OWNER)
      .mutation(api.pages.urlForUpload, { storageId });
    expect(url).toBeTruthy();
  });
});
