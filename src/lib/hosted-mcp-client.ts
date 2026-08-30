import { getFunctionName, type FunctionReference } from "convex/server";
import {
  ConvexError,
  convexToJson,
  jsonToConvex,
  type JSONValue,
  type Value,
} from "convex/values";
import { convexHttpActionOrigin } from "./oauth-server";

type HostedFunctionType = "query" | "mutation" | "action";
type HostedArgs = Record<string, unknown> & { apiKey: string };

type HostedSuccess = { ok: true; value: JSONValue };
type HostedFailure = {
  ok: false;
  error: "invalid_request" | "invalid_token" | "operation_failed";
  error_description: string;
  error_data?: JSONValue;
};

/**
 * The hosted MCP route deliberately does not use ConvexHttpClient. That client
 * serializes every function argument, which placed the OAuth bearer in normal
 * Convex function telemetry. This adapter sends it only in the standard HTTP
 * Authorization header; the Convex HTTP action hashes it and invokes internal
 * functions with the hash.
 */
export class HostedMcpClient {
  async query(
    reference: FunctionReference<"query">,
    args: HostedArgs,
  ): Promise<unknown> {
    return await this.invoke("query", reference, args);
  }

  async mutation(
    reference: FunctionReference<"mutation">,
    args: HostedArgs,
  ): Promise<unknown> {
    return await this.invoke("mutation", reference, args);
  }

  async action(
    reference: FunctionReference<"action">,
    args: HostedArgs,
  ): Promise<unknown> {
    return await this.invoke("action", reference, args);
  }

  private async invoke(
    functionType: HostedFunctionType,
    reference: FunctionReference<HostedFunctionType>,
    args: HostedArgs,
  ): Promise<unknown> {
    const { apiKey, ...input } = args;
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      throw new ConvexError("A bearer credential is required");
    }
    const response = await fetch(
      `${convexHttpActionOrigin()}/oauth/internal/mcp`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          functionName: getFunctionName(reference),
          functionType,
          input: convexToJson(input as Value),
        }),
        cache: "no-store",
      },
    );

    let payload: HostedSuccess | HostedFailure;
    try {
      payload = (await response.json()) as HostedSuccess | HostedFailure;
    } catch {
      throw new Error(`Hosted MCP backend returned HTTP ${response.status}`);
    }
    if (!response.ok || !payload.ok) {
      const failure = payload as HostedFailure;
      if (failure.error_data !== undefined) {
        throw new ConvexError(jsonToConvex(failure.error_data));
      }
      throw new ConvexError(
        failure.error_description || "Hosted MCP operation failed",
      );
    }
    return jsonToConvex(payload.value);
  }
}

let sharedClient: HostedMcpClient | null = null;

export function hostedMcpClient(): HostedMcpClient {
  sharedClient ??= new HostedMcpClient();
  return sharedClient;
}
