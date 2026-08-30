import { anyApi, httpRouter } from "convex/server";
import type { FunctionReference } from "convex/server";
import { Webhook } from "svix";
import type { WebhookEvent } from "@clerk/backend";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  ConvexError,
  convexToJson,
  jsonToConvex,
  type JSONValue,
  type Value,
} from "convex/values";
import { sha256Hex } from "./_agentAuth";
import { pkceChallenge } from "./oauth";

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
      const primaryEmailRecord = evt.data.email_addresses.find(
        (e) => e.id === evt.data.primary_email_address_id,
      );
      const primaryEmail = primaryEmailRecord?.email_address;
      const name =
        [evt.data.first_name, evt.data.last_name].filter(Boolean).join(" ") ||
        undefined;
      await ctx.runMutation(internal.users.upsertFromClerk, {
        clerkId: evt.data.id,
        email: primaryEmail ?? "",
        emailVerified: primaryEmailRecord?.verification?.status === "verified",
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

  if (
    (scopeType !== "user" && scopeType !== "workspace") ||
    !scopeId ||
    !workflowId
  ) {
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

  if (result.status !== "accepted")
    return new Response("not found", { status: 404 });
  return new Response(
    JSON.stringify({ status: "accepted", runId: result.runId }),
    {
      status: 202,
      headers: { "content-type": "application/json" },
    },
  );
});

/**
 * Reached through `anyApi` with a locally written type, because
 * `convex/_generated/` is the checked-in stub here and does not know
 * `internal.buzz.*` yet. Same device, and the same reason, as
 * `convex/buzz/keys.ts`. Delete the cast the first time the CLI regenerates.
 */
const fireWebhookRef = anyApi.buzz.workflows
  .fireWebhook as unknown as FunctionReference<
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

type OAuthExchangeArgs = {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  accessTokenHash: string;
  refreshTokenHash: string;
  resource: string;
};

type OAuthRefreshArgs = {
  refreshTokenHash: string;
  clientId: string;
  accessTokenHash: string;
  nextRefreshTokenHash: string;
  resource: string;
};

const oauthExchangeRef = anyApi.oauth
  .exchangeAuthorizationCode as unknown as FunctionReference<
  "mutation",
  "internal",
  OAuthExchangeArgs,
  unknown
>;
const oauthRefreshRef = anyApi.oauth
  .refreshAccessToken as unknown as FunctionReference<
  "mutation",
  "internal",
  OAuthRefreshArgs,
  unknown
>;

type DeviceCreateArgs = {
  deviceCodeHash: string;
  userCode: string;
  clientName: string;
  clientIp?: string;
  proxyAuthorized: boolean;
};

type DeviceClaimArgs = {
  deviceCodeHash: string;
  keyHash?: string;
  keyPrefix?: string;
};

const deviceCreateRef = anyApi.agentAuth
  .createDeviceRequest as unknown as FunctionReference<
  "mutation",
  "internal",
  DeviceCreateArgs,
  unknown
>;
const deviceClaimRef = anyApi.agentAuth
  .claimDeviceRequest as unknown as FunctionReference<
  "mutation",
  "internal",
  DeviceClaimArgs,
  unknown
>;
const oauthUserInfoRef = anyApi.oauth.userInfo as unknown as FunctionReference<
  "query",
  "internal",
  { accessTokenHash: string; resource: string },
  unknown
>;

type CompanyOsBackendArgs = {
  accessTokenHash: string;
  resource: string;
  objectType?:
    | "workspace"
    | "space"
    | "project"
    | "list"
    | "task"
    | "agent"
    | "run";
  parentType?: "space" | "project" | "folder" | "list" | "agent";
  parentId?: string;
  paginationOpts?: { numItems: number; cursor: string | null };
  legacy?: boolean;
  externalInstallationId?: string;
};

const companyOsAccountRef = anyApi.companyOsConnector
  .account as unknown as FunctionReference<
  "query",
  "internal",
  Pick<CompanyOsBackendArgs, "accessTokenHash" | "resource">,
  unknown
>;
const companyOsSnapshotRef = anyApi.companyOsConnector
  .snapshot as unknown as FunctionReference<
  "mutation",
  "internal",
  Required<
    Pick<
      CompanyOsBackendArgs,
      "accessTokenHash" | "resource" | "objectType" | "paginationOpts"
    >
  > &
    Pick<CompanyOsBackendArgs, "parentType" | "parentId" | "legacy">,
  unknown
>;
const companyOsCurrentInstallationRef = anyApi.companyOsConnector
  .currentInstallation as unknown as FunctionReference<
  "query",
  "internal",
  Pick<CompanyOsBackendArgs, "accessTokenHash" | "resource">,
  unknown
>;
const companyOsUpsertInstallationRef = anyApi.companyOsConnector
  .upsertInstallation as unknown as FunctionReference<
  "mutation",
  "internal",
  Required<
    Pick<
      CompanyOsBackendArgs,
      "accessTokenHash" | "resource" | "externalInstallationId"
    >
  >,
  unknown
>;
const companyOsDisconnectInstallationRef = anyApi.companyOsConnector
  .disconnectInstallation as unknown as FunctionReference<
  "mutation",
  "internal",
  Required<
    Pick<
      CompanyOsBackendArgs,
      "accessTokenHash" | "resource" | "externalInstallationId"
    >
  >,
  unknown
>;

type HostedMcpDispatchArgs = {
  operation: string;
  apiKeyHash: string;
  input: unknown;
};

const hostedMcpDispatchers = {
  "agentApi:query": anyApi.agentApi._hostedMcpQuery,
  "agentApi:mutation": anyApi.agentApi._hostedMcpMutation,
  "agentGrants:query": anyApi.agentGrants._hostedMcpQuery,
  "agentGrants:mutation": anyApi.agentGrants._hostedMcpMutation,
  "buzz/agentChat:query": anyApi.buzz.agentChat._hostedMcpQuery,
  "buzz/agentChat:mutation": anyApi.buzz.agentChat._hostedMcpMutation,
  "x402:query": anyApi.x402._hostedMcpQuery,
} as const;

const hostedMcpSearchRef = anyApi.agentAi
  ._hostedMcpSearch as unknown as FunctionReference<
  "action",
  "internal",
  {
    apiKeyHash: string;
    query: string;
    kinds?: ("doc" | "task" | "page" | "message")[];
  },
  unknown
>;

const hostedMcpSettleTopupRef = anyApi.x402Actions
  ._hostedMcpSettleTopup as unknown as FunctionReference<
  "action",
  "internal",
  { apiKeyHash: string; xPayment: string; credits: number },
  unknown
>;

function companyOsHttpJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      pragma: "no-cache",
    },
  });
}

function requiredString(
  input: Record<string, unknown>,
  key: string,
): string | null {
  const value = input[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function hostedMcpHttpJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      pragma: "no-cache",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Private adapter for the hosted MCP route. The OAuth bearer is confined to
// this HTTP action's Authorization header. Only its SHA-256 hash crosses into
// internal Convex functions, keeping the raw credential out of function args
// and normal query/mutation/action telemetry.
const handleHostedMcpBackend = httpAction(async (ctx, request) => {
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = /^Bearer ([^\s]+)$/i.exec(authorization)?.[1];
  if (!bearer) {
    return hostedMcpHttpJson(
      {
        ok: false,
        error: "invalid_token",
        error_description: "A Bearer token is required",
      },
      401,
    );
  }
  const raw = await request.text();
  if (raw.length > 128 * 1024) {
    return hostedMcpHttpJson(
      {
        ok: false,
        error: "invalid_request",
        error_description: "Request body is too large",
      },
      413,
    );
  }

  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) throw new Error("not an object");
    body = parsed;
  } catch {
    return hostedMcpHttpJson(
      {
        ok: false,
        error: "invalid_request",
        error_description: "Body must be a JSON object",
      },
      400,
    );
  }

  const functionName = body.functionName;
  const functionType = body.functionType;
  if (
    typeof functionName !== "string" ||
    (functionType !== "query" &&
      functionType !== "mutation" &&
      functionType !== "action") ||
    body.input === undefined
  ) {
    return hostedMcpHttpJson(
      {
        ok: false,
        error: "invalid_request",
        error_description: "functionName, functionType, and input are required",
      },
      400,
    );
  }

  let input: unknown;
  try {
    input = jsonToConvex(body.input as JSONValue);
  } catch {
    return hostedMcpHttpJson(
      {
        ok: false,
        error: "invalid_request",
        error_description: "input is not valid Convex JSON",
      },
      400,
    );
  }
  if (
    !isRecord(input) ||
    Object.prototype.hasOwnProperty.call(input, "apiKey") ||
    Object.prototype.hasOwnProperty.call(input, "apiKeyHash")
  ) {
    return hostedMcpHttpJson(
      {
        ok: false,
        error: "invalid_request",
        error_description: "input must be an object without credentials",
      },
      400,
    );
  }

  const apiKeyHash = sha256Hex(bearer);
  try {
    let value: unknown;
    if (functionType === "action") {
      if (functionName === "agentAi:search") {
        value = await ctx.runAction(hostedMcpSearchRef, {
          apiKeyHash,
          ...(input as {
            query: string;
            kinds?: ("doc" | "task" | "page" | "message")[];
          }),
        });
      } else if (functionName === "x402Actions:settleTopup") {
        value = await ctx.runAction(hostedMcpSettleTopupRef, {
          apiKeyHash,
          ...(input as { xPayment: string; credits: number }),
        });
      } else {
        throw new ConvexError("Unknown hosted MCP operation");
      }
    } else {
      const separator = functionName.lastIndexOf(":");
      const moduleName = functionName.slice(0, separator);
      const operation = functionName.slice(separator + 1);
      const dispatcherKey =
        `${moduleName}:${functionType}` as keyof typeof hostedMcpDispatchers;
      const dispatcher = hostedMcpDispatchers[dispatcherKey];
      if (!dispatcher || separator < 1 || operation.length === 0) {
        throw new ConvexError("Unknown hosted MCP operation");
      }
      const args: HostedMcpDispatchArgs = { operation, apiKeyHash, input };
      if (functionType === "query") {
        value = await ctx.runQuery(
          dispatcher as unknown as FunctionReference<
            "query",
            "internal",
            HostedMcpDispatchArgs,
            unknown
          >,
          args,
        );
      } else {
        value = await ctx.runMutation(
          dispatcher as unknown as FunctionReference<
            "mutation",
            "internal",
            HostedMcpDispatchArgs,
            unknown
          >,
          args,
        );
      }
    }
    return hostedMcpHttpJson({
      ok: true,
      value: convexToJson((value === undefined ? null : value) as Value),
    });
  } catch (error) {
    if (error instanceof ConvexError) {
      const errorData = convexToJson(error.data);
      const description =
        typeof error.data === "string" ? error.data : "Operation refused";
      const invalidToken = /invalid api key/i.test(description);
      return hostedMcpHttpJson(
        {
          ok: false,
          error: invalidToken ? "invalid_token" : "operation_failed",
          error_description: description,
          error_data: errorData,
        },
        invalidToken ? 401 : 400,
      );
    }
    return hostedMcpHttpJson(
      {
        ok: false,
        error: "operation_failed",
        error_description: "Hosted MCP operation failed",
      },
      500,
    );
  }
});

// Token exchange secrets stay in a redacted Authorization header. Only the
// PKCE challenge and SHA-256 credential hashes cross into Convex mutation
// arguments, preventing plaintext access/refresh tokens or code verifiers
// from appearing in function telemetry.
const handleOAuthTokenBackend = httpAction(async (ctx, request) => {
  const raw = await request.text();
  if (raw.length > 16 * 1024) {
    return companyOsHttpJson(
      {
        error: "invalid_request",
        error_description: "Request body is too large",
      },
      413,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return companyOsHttpJson(
      { error: "invalid_request", error_description: "Body must be JSON" },
      400,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return companyOsHttpJson(
      { error: "invalid_request", error_description: "Body must be an object" },
      400,
    );
  }
  const input = parsed as Record<string, unknown>;
  const operation = requiredString(input, "operation");
  const clientId = requiredString(input, "clientId");
  const resource = requiredString(input, "resource");
  const accessTokenHash = requiredString(input, "accessTokenHash");
  if (!operation || !clientId || !resource || !accessTokenHash) {
    return companyOsHttpJson(
      {
        error: "invalid_request",
        error_description: "Token request is incomplete",
      },
      400,
    );
  }
  const authorization = request.headers.get("authorization") ?? "";
  try {
    if (operation === "authorization_code") {
      const verifier = /^PKCE ([A-Za-z0-9._~-]{43,128})$/.exec(
        authorization,
      )?.[1];
      const codeHash = requiredString(input, "codeHash");
      const redirectUri = requiredString(input, "redirectUri");
      const refreshTokenHash = requiredString(input, "refreshTokenHash");
      if (!verifier || !codeHash || !redirectUri || !refreshTokenHash) {
        return companyOsHttpJson(
          {
            error: "invalid_request",
            error_description: "Token request is incomplete",
          },
          400,
        );
      }
      return companyOsHttpJson(
        await ctx.runMutation(oauthExchangeRef, {
          codeHash,
          clientId,
          redirectUri,
          codeChallenge: pkceChallenge(verifier),
          accessTokenHash,
          refreshTokenHash,
          resource,
        }),
      );
    }
    if (operation === "refresh_token") {
      const refreshToken = /^Bearer ([^\s]+)$/i.exec(authorization)?.[1];
      const nextRefreshTokenHash = requiredString(
        input,
        "nextRefreshTokenHash",
      );
      if (!refreshToken || !nextRefreshTokenHash) {
        return companyOsHttpJson(
          {
            error: "invalid_request",
            error_description: "Token request is incomplete",
          },
          400,
        );
      }
      return companyOsHttpJson(
        await ctx.runMutation(oauthRefreshRef, {
          refreshTokenHash: sha256Hex(refreshToken),
          clientId,
          accessTokenHash,
          nextRefreshTokenHash,
          resource,
        }),
      );
    }
    return companyOsHttpJson(
      {
        error: "invalid_request",
        error_description: "Unknown token operation",
      },
      400,
    );
  } catch {
    return companyOsHttpJson(
      { error: "invalid_grant", error_description: "Token grant failed" },
      400,
    );
  }
});

// Device-flow credentials use the same boundary rule as OAuth tokens: raw
// device codes and the proxy shared secret stay in Authorization headers.
// Only SHA-256 hashes and an action-computed trust decision enter mutations.
const handleOAuthDeviceBackend = httpAction(async (ctx, request) => {
  const raw = await request.text();
  if (raw.length > 16 * 1024) {
    return companyOsHttpJson(
      {
        error: "invalid_request",
        error_description: "Request body is too large",
      },
      413,
    );
  }
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return companyOsHttpJson(
      { error: "invalid_request", error_description: "Body must be JSON" },
      400,
    );
  }
  const operation = requiredString(input, "operation");
  const authorization = request.headers.get("authorization") ?? "";
  try {
    if (operation === "create") {
      const deviceCodeHash = requiredString(input, "deviceCodeHash");
      const userCode = requiredString(input, "userCode");
      const clientName =
        typeof input.clientName === "string" ? input.clientName : "";
      if (!deviceCodeHash || !userCode) {
        return companyOsHttpJson(
          {
            error: "invalid_request",
            error_description: "Device request is incomplete",
          },
          400,
        );
      }
      const suppliedProxySecret = /^Bearer (.+)$/i.exec(authorization)?.[1];
      const expectedProxySecret = process.env.DEVICE_PROXY_SECRET;
      const proxyAuthorized = expectedProxySecret
        ? suppliedProxySecret === expectedProxySecret
        : true;
      return companyOsHttpJson(
        await ctx.runMutation(deviceCreateRef, {
          deviceCodeHash,
          userCode,
          clientName,
          ...(typeof input.clientIp === "string"
            ? { clientIp: input.clientIp }
            : {}),
          proxyAuthorized,
        }),
      );
    }
    if (operation === "claim") {
      const deviceCode = /^Device ([^\s]+)$/i.exec(authorization)?.[1];
      if (!deviceCode) {
        return companyOsHttpJson(
          {
            error: "invalid_request",
            error_description: "A device credential is required",
          },
          401,
        );
      }
      return companyOsHttpJson(
        await ctx.runMutation(deviceClaimRef, {
          deviceCodeHash: sha256Hex(deviceCode),
          ...(typeof input.keyHash === "string"
            ? { keyHash: input.keyHash }
            : {}),
          ...(typeof input.keyPrefix === "string"
            ? { keyPrefix: input.keyPrefix }
            : {}),
        }),
      );
    }
    return companyOsHttpJson(
      {
        error: "invalid_request",
        error_description: "Unknown device operation",
      },
      400,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Device request failed";
    return companyOsHttpJson(
      {
        error: /too many/i.test(message) ? "slow_down" : "invalid_request",
        error_description: message,
      },
      /too many/i.test(message) ? 429 : 400,
    );
  }
});

const handleOAuthUserInfoBackend = httpAction(async (ctx, request) => {
  const bearer = /^Bearer ([^\s]+)$/i.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];
  if (!bearer) {
    return companyOsHttpJson(
      {
        error: "invalid_token",
        error_description: "A Bearer token is required",
      },
      401,
    );
  }
  const raw = await request.text();
  if (raw.length > 4 * 1024) {
    return companyOsHttpJson(
      {
        error: "invalid_request",
        error_description: "Request body is too large",
      },
      413,
    );
  }
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return companyOsHttpJson(
      { error: "invalid_request", error_description: "Body must be JSON" },
      400,
    );
  }
  const resource = requiredString(input, "resource");
  if (!resource) {
    return companyOsHttpJson(
      { error: "invalid_request", error_description: "resource is required" },
      400,
    );
  }
  try {
    return companyOsHttpJson(
      await ctx.runQuery(oauthUserInfoRef, {
        accessTokenHash: sha256Hex(bearer),
        resource,
      }),
    );
  } catch {
    return companyOsHttpJson(
      {
        error: "invalid_token",
        error_description: "The access token is invalid",
      },
      401,
    );
  }
});

function companyOsHttpFailure(error: unknown) {
  const message =
    error instanceof Error ? error.message : "Connector request failed";
  if (/missing required scope/i.test(message)) {
    return companyOsHttpJson(
      {
        error: "insufficient_scope",
        error_description: "The access token is missing the required scope",
      },
      403,
    );
  }
  if (/access token|no longer authorized/i.test(message)) {
    return companyOsHttpJson(
      {
        error: "invalid_token",
        error_description:
          "The access token is invalid or no longer authorized",
      },
      401,
    );
  }
  if (/outside the authorized workspace/i.test(message)) {
    return companyOsHttpJson(
      {
        error: "not_found",
        error_description: "The requested object was not found",
      },
      404,
    );
  }
  if (
    /required|invalid|page size|do not accept|use the authorized|already bound|installation identity|active installation/i.test(
      message,
    )
  ) {
    return companyOsHttpJson(
      { error: "invalid_request", error_description: message },
      400,
    );
  }
  return companyOsHttpJson(
    { error: "server_error", error_description: "Connector request failed" },
    500,
  );
}

// Private backend adapter for the canonical www.operate.to connector routes.
// The bearer remains in an HTTP Authorization header and is hashed here before
// any Convex function invocation, so plaintext credentials never enter
// query/mutation arguments or their telemetry.
const handleCompanyOsBackend = httpAction(async (ctx, request) => {
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = /^Bearer ([^\s]+)$/i.exec(authorization)?.[1];
  if (!bearer) {
    return companyOsHttpJson(
      {
        error: "invalid_token",
        error_description: "A Bearer token is required",
      },
      401,
    );
  }
  const raw = await request.text();
  if (raw.length > 32 * 1024) {
    return companyOsHttpJson(
      {
        error: "invalid_request",
        error_description: "Request body is too large",
      },
      413,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return companyOsHttpJson(
      { error: "invalid_request", error_description: "Body must be JSON" },
      400,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return companyOsHttpJson(
      { error: "invalid_request", error_description: "Body must be an object" },
      400,
    );
  }
  const input = parsed as Record<string, unknown>;
  const operation = input.operation;
  const resource = input.resource;
  if (typeof operation !== "string" || typeof resource !== "string") {
    return companyOsHttpJson(
      {
        error: "invalid_request",
        error_description: "operation and resource are required",
      },
      400,
    );
  }
  const accessTokenHash = sha256Hex(bearer);
  try {
    if (operation === "account") {
      return companyOsHttpJson(
        await ctx.runQuery(companyOsAccountRef, { accessTokenHash, resource }),
      );
    }
    if (operation === "snapshot") {
      const objectType = input.objectType as CompanyOsBackendArgs["objectType"];
      const paginationOpts =
        input.paginationOpts as CompanyOsBackendArgs["paginationOpts"];
      if (!objectType || !paginationOpts) {
        return companyOsHttpJson(
          {
            error: "invalid_request",
            error_description: "objectType and paginationOpts are required",
          },
          400,
        );
      }
      return companyOsHttpJson(
        await ctx.runMutation(companyOsSnapshotRef, {
          accessTokenHash,
          resource,
          objectType,
          paginationOpts,
          ...(typeof input.parentType === "string"
            ? {
                parentType:
                  input.parentType as CompanyOsBackendArgs["parentType"],
              }
            : {}),
          ...(typeof input.parentId === "string"
            ? { parentId: input.parentId }
            : {}),
          ...(typeof input.legacy === "boolean"
            ? { legacy: input.legacy }
            : {}),
        }),
      );
    }
    if (operation === "installation.get") {
      return companyOsHttpJson(
        await ctx.runQuery(companyOsCurrentInstallationRef, {
          accessTokenHash,
          resource,
        }),
      );
    }
    if (operation === "installation.upsert") {
      if (typeof input.externalInstallationId !== "string") {
        return companyOsHttpJson(
          {
            error: "invalid_request",
            error_description: "externalInstallationId is required",
          },
          400,
        );
      }
      return companyOsHttpJson(
        await ctx.runMutation(companyOsUpsertInstallationRef, {
          accessTokenHash,
          resource,
          externalInstallationId: input.externalInstallationId,
        }),
      );
    }
    if (operation === "installation.disconnect") {
      if (
        typeof input.externalInstallationId !== "string" ||
        input.externalInstallationId.trim().length === 0
      ) {
        return companyOsHttpJson(
          {
            error: "invalid_request",
            error_description: "externalInstallationId is required",
          },
          400,
        );
      }
      return companyOsHttpJson(
        await ctx.runMutation(companyOsDisconnectInstallationRef, {
          accessTokenHash,
          resource,
          externalInstallationId: input.externalInstallationId,
        }),
      );
    }
    return companyOsHttpJson(
      { error: "invalid_request", error_description: "Unknown operation" },
      400,
    );
  } catch (error) {
    return companyOsHttpFailure(error);
  }
});

const http = httpRouter();
http.route({ path: "/clerk", method: "POST", handler: handleClerkWebhook });
http.route({
  path: "/oauth/internal/mcp",
  method: "POST",
  handler: handleHostedMcpBackend,
});
http.route({
  path: "/oauth/internal/token",
  method: "POST",
  handler: handleOAuthTokenBackend,
});
http.route({
  path: "/oauth/internal/device",
  method: "POST",
  handler: handleOAuthDeviceBackend,
});
http.route({
  path: "/oauth/internal/userinfo",
  method: "POST",
  handler: handleOAuthUserInfoBackend,
});
http.route({
  path: "/companyos/internal",
  method: "POST",
  handler: handleCompanyOsBackend,
});
// pathPrefix, because the community and the workflow id are path segments.
http.route({
  pathPrefix: "/hooks/",
  method: "POST",
  handler: fireWorkflowWebhook,
});
export default http;
