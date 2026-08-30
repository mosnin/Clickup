import { ConvexError, asObjectValidator } from "convex/values";
import type { GenericValidator, ValidatorJSON } from "convex/values";
import type {
  GenericMutationCtx,
  GenericQueryCtx,
  MutationBuilder,
  QueryBuilder,
} from "convex/server";
import type { DataModel } from "./_generated/dataModel";
import { validatedAgentKeyHash } from "./_agentAuth";

/**
 * A hosted MCP request starts in a Convex HTTP action, where the bearer is
 * hashed before any normal Convex function is invoked. These registries let
 * that action reach the exact same handlers as the long-standing public agent
 * API without ever putting the raw bearer in query/mutation arguments.
 *
 * Public calls keep their original validators and behavior. The internal
 * dispatcher repeats the original argument validation before invoking the
 * handler with an opaque, module-created hash credential in place of apiKey.
 */

type HostedCtx = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>;
type HostedHandler = (ctx: HostedCtx, args: Record<string, unknown>) => unknown;

export type HostedMcpRegistry = Map<
  string,
  { args: ValidatorJSON; returns?: ValidatorJSON; handler: HostedHandler }
>;

type FunctionDefinition = {
  args?: Record<string, GenericValidator> | GenericValidator;
  returns?: GenericValidator;
  handler: HostedHandler;
};

export function hostedMcpQueryBuilder(
  registry: HostedMcpRegistry,
  name: string,
  builder: QueryBuilder<DataModel, "public">,
): QueryBuilder<DataModel, "public"> {
  return ((definition: FunctionDefinition) => {
    register(registry, name, definition);
    return builder(definition as never);
  }) as QueryBuilder<DataModel, "public">;
}

export function hostedMcpMutationBuilder(
  registry: HostedMcpRegistry,
  name: string,
  builder: MutationBuilder<DataModel, "public">,
): MutationBuilder<DataModel, "public"> {
  return ((definition: FunctionDefinition) => {
    register(registry, name, definition);
    return builder(definition as never);
  }) as MutationBuilder<DataModel, "public">;
}

function register(
  registry: HostedMcpRegistry,
  name: string,
  definition: FunctionDefinition,
) {
  if (registry.has(name)) {
    throw new Error(`Duplicate hosted MCP function: ${name}`);
  }
  const objectValidator = asObjectValidator(definition.args ?? {});
  const args = (objectValidator as unknown as { json: ValidatorJSON }).json;
  if (args.type !== "object" || args.value.apiKey === undefined) {
    throw new Error(`Hosted MCP function ${name} must declare apiKey`);
  }
  const returns = definition.returns
    ? (definition.returns as unknown as { json: ValidatorJSON }).json
    : undefined;
  registry.set(name, {
    args,
    ...(returns ? { returns } : {}),
    handler: definition.handler,
  });
}

export async function dispatchHostedMcp(
  registry: HostedMcpRegistry,
  ctx: HostedCtx,
  args: {
    operation: string;
    apiKeyHash: string;
    input: unknown;
  },
): Promise<unknown> {
  const entry = registry.get(args.operation);
  if (!entry) throw new ConvexError("Unknown hosted MCP operation");
  if (!isPlainObject(args.input)) {
    throw new ConvexError("Hosted MCP input must be an object");
  }
  if (Object.prototype.hasOwnProperty.call(args.input, "apiKey")) {
    throw new ConvexError("Hosted MCP input must not contain apiKey");
  }

  // Validate using the public function's own schema. The placeholder exists
  // only in this stack frame; the handler receives the unforgeable hash
  // credential below and no secret or bearer-like value is added to telemetry.
  const db = ctx.db as unknown as {
    normalizeId(tableName: string, id: string): unknown | null;
  };
  validate(
    entry.args,
    { ...args.input, apiKey: "hosted-mcp-http-boundary" },
    (tableName, id) => db.normalizeId(tableName, id) !== null,
  );
  const handlerArgs = {
    ...args.input,
    apiKey: validatedAgentKeyHash(args.apiKeyHash),
  };
  const result = await entry.handler(ctx, handlerArgs);
  if (entry.returns) {
    validate(
      entry.returns,
      result,
      (tableName, id) => db.normalizeId(tableName, id) !== null,
      "return value",
    );
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validatorError(label: string, message: string): never {
  throw new ConvexError(`Invalid hosted MCP ${label}: ${message}`);
}

// Convex normally applies these validators before a public handler runs. The
// internal dispatcher calls the registered handler directly, so it mirrors
// that check instead of trusting the Next route's Zod catalog to stay in sync.
function validate(
  validator: ValidatorJSON,
  value: unknown,
  idMatchesTable: (tableName: string, id: string) => boolean,
  label = "arguments",
): void {
  const invalid = (message: string): never => validatorError(label, message);
  switch (validator.type) {
    case "null":
      if (value !== null) return invalid("expected null");
      return;
    case "number":
      if (typeof value !== "number") return invalid("expected number");
      return;
    case "bigint":
      if (typeof value !== "bigint") return invalid("expected bigint");
      return;
    case "boolean":
      if (typeof value !== "boolean") return invalid("expected boolean");
      return;
    case "string":
      if (typeof value !== "string") return invalid("expected string");
      return;
    case "bytes":
      if (!(value instanceof ArrayBuffer)) return invalid("expected bytes");
      return;
    case "any":
      return;
    case "literal":
      if (value !== validator.value) return invalid("literal did not match");
      return;
    case "id":
      if (
        typeof value !== "string" ||
        !idMatchesTable(validator.tableName, value)
      ) {
        return invalid(`expected id for table ${validator.tableName}`);
      }
      return;
    case "array":
      if (!Array.isArray(value)) return invalid("expected array");
      for (const item of value) {
        validate(validator.value, item, idMatchesTable, label);
      }
      return;
    case "union":
      for (const member of validator.value) {
        try {
          validate(member, value, idMatchesTable, label);
          return;
        } catch {
          // Try the next member.
        }
      }
      return invalid("no union member matched");
    case "object": {
      if (!isPlainObject(value)) return invalid("expected object");
      for (const [key, field] of Object.entries(validator.value)) {
        const fieldValue = value[key];
        if (fieldValue === undefined) {
          if (!field.optional) return invalid(`missing required field ${key}`);
        } else {
          validate(field.fieldType, fieldValue, idMatchesTable, label);
        }
      }
      for (const key of Object.keys(value)) {
        if (validator.value[key] === undefined) {
          return invalid(`unexpected field ${key}`);
        }
      }
      return;
    }
    case "record": {
      if (!isPlainObject(value)) return invalid("expected record");
      for (const [key, recordValue] of Object.entries(value)) {
        validate(validator.keys, key, idMatchesTable, label);
        validate(
          validator.values.fieldType,
          recordValue,
          idMatchesTable,
          label,
        );
      }
      return;
    }
  }
}
