import { afterEach, describe, expect, it } from "vitest";
import { GET } from "../src/app/api/health/route";

describe("production health endpoint", () => {
  const originalConvexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;

  afterEach(() => {
    if (originalConvexUrl === undefined) {
      delete process.env.NEXT_PUBLIC_CONVEX_URL;
    } else {
      process.env.NEXT_PUBLIC_CONVEX_URL = originalConvexUrl;
    }
  });

  it("fails closed when the system of record is not configured", async () => {
    delete process.env.NEXT_PUBLIC_CONVEX_URL;
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({
      status: "unavailable",
      dependencies: { convex: "misconfigured" },
    });
    expect(body.checkedAt).toEqual(expect.any(String));
  });
});
