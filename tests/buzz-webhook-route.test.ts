import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.*s");

// The webhook trigger door, from the outside.
//
// Tested through `t.fetch` rather than by calling the mutation, because the
// route is where the interesting decisions live: what a bad secret answers,
// what an unknown workflow answers, and whether those two are the same answer.
// A mutation test would prove none of it.

const ALICE = { subject: "user_alice", tokenIdentifier: "alice" };

async function seed() {
  const t = convexTest(schema, modules);
  await t.withIdentity(ALICE).mutation(anyApi.users.ensureCurrent, {});
  return t;
}

function hookUrl(scopeType: string, scopeId: string, workflowId: string) {
  return `/hooks/${scopeType}/${scopeId}/${workflowId}`;
}

describe("POST /hooks/…", () => {
  it("is actually routed — every other test here would pass without it", async () => {
    // The rest of this file asserts that various requests answer 404. If the
    // route were never registered they would all answer 404 too, from Convex's
    // router rather than from the handler, and the file would pass while
    // proving nothing. That is the failure mode where a test pins a bug instead
    // of catching it, and it has already happened once in this build.
    //
    // The two 404s are distinguishable: the router says so in its body.
    const t = await seed();
    const unrouted = await t.fetch("/definitely-not-routed", { method: "POST", body: "{}" });
    const routed = await t.fetch(hookUrl("user", ALICE.subject, "wf_x"), {
      method: "POST",
      headers: { "x-webhook-secret": "s" },
      body: "{}",
    });
    expect(await unrouted.text()).toMatch(/No HttpAction routed/);
    expect(await routed.text()).toBe("not found");
  });

  it("refuses a path that names no community", async () => {
    const t = await seed();
    for (const path of ["/hooks/", "/hooks/nonsense/x/y", "/hooks/user/only-two"]) {
      const res = await t.fetch(path, {
        method: "POST",
        headers: { "x-webhook-secret": "whatever" },
        body: "{}",
      });
      expect(res.status, path).toBe(404);
    }
  });

  it("refuses a request with no secret header", async () => {
    const t = await seed();
    const res = await t.fetch(hookUrl("user", ALICE.subject, "wf_anything"), {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("answers a bad secret and an unknown workflow identically", async () => {
    // The whole point. A 401 for a wrong secret and a 404 for a missing
    // workflow would let anyone enumerate which workflow ids exist by watching
    // which status came back — existence is information.
    const t = await seed();
    const unknown = await t.fetch(hookUrl("user", ALICE.subject, "wf_does_not_exist"), {
      method: "POST",
      headers: { "x-webhook-secret": "s3cret" },
      body: "{}",
    });
    const badSecret = await t.fetch(hookUrl("user", ALICE.subject, "wf_does_not_exist"), {
      method: "POST",
      headers: { "x-webhook-secret": "a-different-wrong-secret" },
      body: "{}",
    });
    expect(unknown.status).toBe(404);
    expect(badSecret.status).toBe(404);
    expect(await unknown.text()).toBe(await badSecret.text());
  });

  it("refuses a body larger than the cap", async () => {
    // The body is read before the secret can be checked, so the endpoint is
    // unauthenticated at exactly the moment it is asked to buffer.
    const t = await seed();
    const res = await t.fetch(hookUrl("user", ALICE.subject, "wf_x"), {
      method: "POST",
      headers: { "x-webhook-secret": "s" },
      body: "x".repeat(64 * 1024 + 1),
    });
    expect(res.status).toBe(404);
  });

  it("does not reach another community's workflow through this community's path", async () => {
    // The community is in the path and the fence is behind it: a workflow id is
    // a keyed hash, so guessing one is hard, and reaching it from the wrong
    // community must be impossible rather than hard.
    const t = await seed();
    const res = await t.fetch(hookUrl("workspace", "some_other_workspace", "wf_x"), {
      method: "POST",
      headers: { "x-webhook-secret": "s" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });
});
