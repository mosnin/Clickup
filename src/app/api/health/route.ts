import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

export const dynamic = "force-dynamic";

const TIMEOUT_MS = 3_000;
const healthPing = makeFunctionReference<"query">("health:ping");

async function withTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Health dependency timed out")),
      TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function GET() {
  const checkedAt = new Date().toISOString();
  const commit = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? null;
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;

  if (!convexUrl) {
    return Response.json(
      {
        status: "unavailable",
        checkedAt,
        commit,
        dependencies: { convex: "misconfigured" },
      },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }

  try {
    const client = new ConvexHttpClient(convexUrl);
    const ping = (await withTimeout(client.query(healthPing, {}))) as {
      ok?: boolean;
      config?: Record<string, boolean>;
    };
    return Response.json(
      {
        status: "ok",
        checkedAt,
        commit,
        dependencies: { convex: "ok" },
        config: ping.config ?? {},
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      {
        status: "unavailable",
        checkedAt,
        commit,
        dependencies: { convex: "unavailable" },
      },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
