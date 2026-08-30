import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getAccount } from "../src/app/api/companyos/v1/account/route";
import { GET as getSnapshot } from "../src/app/api/companyos/v1/snapshot/route";

const TOKEN = "opa_route_contract";

function object(
  objectType: "workspace" | "space" | "project",
  id: string,
  sourcePath: string,
) {
  return {
    objectType,
    externalId: `operate:${objectType}:${id}`,
    version: `version_${id}`,
    updatedAt: 1_788_105_600_000,
    sourcePath,
    data: { name: id },
  };
}

describe("Company OS Connect canonical HTTP routes", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://operate.to";
    process.env.CONVEX_SITE_URL = "https://test.convex.site";
    process.env.COMPANYOS_CURSOR_SECRET = "c".repeat(32);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CONVEX_SITE_URL;
    delete process.env.COMPANYOS_CURSOR_SECRET;
  });

  it("returns the shared account shape and keeps the bearer in the backend header", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        providerId: "operate",
        subject: "user_123",
        oauthClientId: "client_123",
        scopes: ["companyos:account:read"],
        workspace: {
          externalId: "operate:workspace:workspace_123",
          name: "Acme",
          slug: "acme",
          role: "admin",
          sourcePath: "/dashboard/w/workspace_123",
        },
      }),
    );
    const response = await getAccount(
      new Request("https://www.operate.to/api/companyos/v1/account", {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      subject: { id: "user_123" },
      tenant: { id: "operate:workspace:workspace_123", label: "Acme" },
      roles: ["admin"],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://test.convex.site/companyos/internal",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }),
      }),
    );
    const body = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(body).not.toHaveProperty("accessToken");
    expect(body).not.toHaveProperty("token");
  });

  it("flattens bounded provider pages into the v1 snapshot envelope", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          operation: string;
          objectType: string;
        };
        expect(body.operation).toBe("snapshot");
        if (body.objectType === "workspace") {
          return Response.json({
            page: [object("workspace", "workspace_123", "/dashboard/w/workspace_123")],
            isDone: true,
            continueCursor: "workspace:end",
          });
        }
        if (body.objectType === "space") {
          return Response.json({
            page: [object("space", "space_123", "/dashboard/s/space_123")],
            isDone: true,
            continueCursor: "space:end",
          });
        }
        if (body.objectType === "project") {
          return Response.json({
            page: [object("project", "project_123", "/dashboard/p/project_123")],
            isDone: true,
            continueCursor: "project:end",
          });
        }
        return Response.json({
          page: [],
          isDone: true,
          continueCursor: "end",
        });
      },
    );

    const response = await getSnapshot(
      new Request("https://www.operate.to/api/companyos/v1/snapshot?limit=3", {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      objects: Array<Record<string, unknown>>;
      nextCursor: string | null;
      checkpoint?: string;
    };
    expect(body.objects).toHaveLength(3);
    expect(body.objects.map((entry) => entry.type)).toEqual([
      "workspace",
      "space",
      "project",
    ]);
    expect(body.objects[2]).toMatchObject({
      id: "operate:project:project_123",
      version: "version_project_123",
      updatedAt: "2026-08-30T16:00:00.000Z",
      sourceUrl: "https://www.operate.to/dashboard/p/project_123",
      data: { name: "project_123" },
    });
    expect(body.nextCursor).toEqual(expect.any(String));
    expect(body.checkpoint).toEqual(expect.any(String));
    expect(body.objects.length).toBeLessThanOrEqual(3);

    const rebound = await getSnapshot(
      new Request(
        `https://www.operate.to/api/companyos/v1/snapshot?cursor=${encodeURIComponent(body.nextCursor!)}`,
        { headers: { Authorization: "Bearer opa_different_tenant" } },
      ),
    );
    expect(rebound.status).toBe(400);
  });

  it("fails closed before contacting the backend without a bearer", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await getSnapshot(
      new Request("https://www.operate.to/api/companyos/v1/snapshot"),
    );
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
