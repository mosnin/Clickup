import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

// Task attachments: metadata rows pointing at Convex file storage, gated by
// the same task-access boundary as everything else, plus a 50MB size cap
// enforced independently of storage.

const modules = import.meta.glob("../convex/**/*.*s");

const OWNER = { subject: "user_owner", email: "owner@acme.com" };
const OUTSIDER = { subject: "user_outsider", email: "outsider@acme.com" };

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    for (const u of [OWNER, OUTSIDER]) {
      await ctx.db.insert("users", { clerkId: u.subject, email: u.email });
    }
  });
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

async function fakeStorageId(t: ReturnType<typeof convexTest>): Promise<Id<"_storage">> {
  return await t.run(async (ctx) => {
    return await ctx.storage.store(new Blob(["hello world"]));
  });
}

describe("attachments", () => {
  it("the task owner can create and list an attachment", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const taskId = await makeTask(t);
    const storageId = await fakeStorageId(t);

    const attachmentId = await t
      .withIdentity(OWNER)
      .mutation(api.attachments.create, {
        taskId,
        storageId,
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 11,
      });
    expect(attachmentId).toBeTruthy();

    const list = await t
      .withIdentity(OWNER)
      .query(api.attachments.listForTask, { taskId });
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("notes.txt");
  });

  it("an outsider cannot create or list attachments on a foreign task", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const taskId = await makeTask(t);
    const storageId = await fakeStorageId(t);

    await expect(
      t.withIdentity(OUTSIDER).mutation(api.attachments.create, {
        taskId,
        storageId,
        name: "sneaky.txt",
        mimeType: "text/plain",
        sizeBytes: 11,
      }),
    ).rejects.toThrow(/forbidden/i);

    await expect(
      t.withIdentity(OUTSIDER).query(api.attachments.listForTask, { taskId }),
    ).rejects.toThrow(/forbidden/i);
  });

  it("rejects attachments over the 50MB cap", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const taskId = await makeTask(t);
    const storageId = await fakeStorageId(t);

    await expect(
      t.withIdentity(OWNER).mutation(api.attachments.create, {
        taskId,
        storageId,
        name: "huge.bin",
        mimeType: "application/octet-stream",
        sizeBytes: 50 * 1024 * 1024 + 1,
      }),
    ).rejects.toThrow(/50 ?MB/i);
  });

  it("remove is access-checked", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const taskId = await makeTask(t);
    const storageId = await fakeStorageId(t);
    const attachmentId = await t
      .withIdentity(OWNER)
      .mutation(api.attachments.create, {
        taskId,
        storageId,
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 11,
      });

    await expect(
      t.withIdentity(OUTSIDER).mutation(api.attachments.remove, {
        attachmentId,
      }),
    ).rejects.toThrow(/forbidden/i);

    await t.withIdentity(OWNER).mutation(api.attachments.remove, {
      attachmentId,
    });
    expect(
      await t
        .withIdentity(OWNER)
        .query(api.attachments.listForTask, { taskId }),
    ).toEqual([]);
  });
});
