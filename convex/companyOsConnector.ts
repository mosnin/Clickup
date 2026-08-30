import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { sha256Hex } from "./_agentAuth";
import { requireOAuthResource } from "./_oauthResource";

const MAX_PAGE_SIZE = 200;

const objectTypeValidator = v.union(
  v.literal("workspace"),
  v.literal("space"),
  v.literal("project"),
  v.literal("list"),
  v.literal("task"),
  v.literal("agent"),
  v.literal("run"),
);

const parentTypeValidator = v.optional(
  v.union(
    v.literal("space"),
    v.literal("project"),
    v.literal("folder"),
    v.literal("list"),
    v.literal("agent"),
  ),
);

const snapshotObjectValidator = v.object({
  objectType: objectTypeValidator,
  externalId: v.string(),
  version: v.string(),
  updatedAt: v.number(),
  sourcePath: v.string(),
  data: v.any(),
});

const snapshotResultValidator = v.object({
  page: v.array(snapshotObjectValidator),
  isDone: v.boolean(),
  continueCursor: v.string(),
});

const installationValidator = v.object({
  externalInstallationId: v.string(),
  workspaceId: v.id("workspaces"),
  oauthSubject: v.string(),
  oauthClientId: v.string(),
  scopes: v.array(v.string()),
  status: v.union(v.literal("active"), v.literal("disconnected")),
  installedAt: v.number(),
  updatedAt: v.number(),
  disconnectedAt: v.optional(v.number()),
});

function installationResult(
  row:
    | Doc<"companyOsInstallations">
    | {
        externalInstallationId: string;
        workspaceId: Id<"workspaces">;
        oauthSubject: string;
        oauthClientId: string;
        scopes: string[];
        status: "active" | "disconnected";
        installedAt: number;
        updatedAt: number;
        disconnectedAt?: number;
      },
) {
  return {
    externalInstallationId: row.externalInstallationId,
    workspaceId: row.workspaceId,
    oauthSubject: row.oauthSubject,
    oauthClientId: row.oauthClientId,
    scopes: row.scopes,
    status: row.status,
    installedAt: row.installedAt,
    updatedAt: row.updatedAt,
    ...(row.disconnectedAt === undefined
      ? {}
      : { disconnectedAt: row.disconnectedAt }),
  };
}

type ConnectorCtx = QueryCtx | MutationCtx;
type ConnectorScope = "companyos:account:read" | "companyos:data:read";

function requireCompanyOsResource(value: string) {
  return requireOAuthResource(value, "companyos").resource;
}

async function requireConnectorToken(
  ctx: ConnectorCtx,
  accessTokenHash: string,
  resource: string,
  requiredScope: ConnectorScope,
  requireActiveInstallation = false,
) {
  const expectedResource = requireCompanyOsResource(resource);
  const token = await ctx.db
    .query("oauthAccessTokens")
    .withIndex("by_token_hash", (q) => q.eq("tokenHash", accessTokenHash))
    .unique();
  if (
    !token ||
    token.revokedAt !== undefined ||
    token.expiresAt <= Date.now() ||
    token.resource !== expectedResource ||
    token.agentId !== undefined ||
    !token.workspaceId ||
    !token.grantId
  ) {
    throw new ConvexError("Invalid Company OS access token");
  }
  const installationBindings = await ctx.db
    .query("companyOsInstallations")
    .withIndex("by_workspace_and_client", (q) =>
      q
        .eq("workspaceId", token.workspaceId!)
        .eq("oauthClientId", token.clientId),
    )
    .take(2);
  // There is one stable installation identity per provider workspace/client.
  // If older data violates that invariant, fail closed instead of choosing an
  // arbitrary authorization cutoff or active grant.
  if (installationBindings.length > 1) {
    throw new ConvexError("Company OS access is no longer authorized");
  }
  const installationBinding = installationBindings[0];
  if (
    installationBinding?.oauthRevokedBefore !== undefined &&
    token.createdAt <= installationBinding.oauthRevokedBefore
  ) {
    throw new ConvexError("Company OS access is no longer authorized");
  }
  if (token.grantId) {
    const grant = await ctx.db
      .query("oauthTokenGrants")
      .withIndex("by_grant_id", (q) => q.eq("grantId", token.grantId!))
      .unique();
    if (!grant || grant.revokedAt !== undefined) {
      throw new ConvexError("Invalid Company OS access token");
    }
  }
  if (!token.scopes.includes(requiredScope)) {
    throw new ConvexError("Company OS access token is missing required scope");
  }
  if (requireActiveInstallation) {
    if (
      installationBinding?.status !== "active" ||
      installationBinding.oauthSubject !== token.userClerkId ||
      installationBinding.oauthGrantId !== token.grantId
    ) {
      throw new ConvexError("Company OS access is no longer authorized");
    }
  }
  const [workspace, membership, user, client] = await Promise.all([
    ctx.db.get(token.workspaceId),
    ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q
          .eq("userClerkId", token.userClerkId)
          .eq("workspaceId", token.workspaceId!),
      )
      .unique(),
    ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", token.userClerkId))
      .first(),
    ctx.db
      .query("oauthClients")
      .withIndex("by_client_id", (q) => q.eq("clientId", token.clientId))
      .unique(),
  ]);
  if (
    !workspace ||
    workspace.suspendedAt !== undefined ||
    !user ||
    user.suspendedAt !== undefined ||
    !membership ||
    membership.role === "member" ||
    !client
  ) {
    throw new ConvexError("Company OS access is no longer authorized");
  }
  return { token, workspace, membership, user, client };
}

function mayReadSpace(
  space: Doc<"spaces">,
  workspace: Doc<"workspaces">,
  subject: string,
) {
  if (space.parentType !== "workspace" || space.parentId !== workspace._id) {
    return false;
  }
  if (!space.private) return true;
  return (
    workspace.ownerClerkId === subject ||
    space.createdByClerkId === subject ||
    space.memberClerkIds?.includes(subject) === true
  );
}

async function requireReadableSpace(
  ctx: ConnectorCtx,
  id: string,
  workspace: Doc<"workspaces">,
  subject: string,
) {
  const space = await ctx.db.get(id as Id<"spaces">);
  if (!space || !mayReadSpace(space, workspace, subject)) {
    throw new ConvexError("Parent object is outside the authorized workspace");
  }
  return space;
}

async function requireReadableProject(
  ctx: ConnectorCtx,
  id: string,
  workspace: Doc<"workspaces">,
  subject: string,
) {
  const project = await ctx.db.get(id as Id<"projects">);
  if (!project) {
    throw new ConvexError("Parent object is outside the authorized workspace");
  }
  await requireReadableSpace(ctx, project.spaceId, workspace, subject);
  return project;
}

async function requireReadableList(
  ctx: ConnectorCtx,
  id: string,
  workspace: Doc<"workspaces">,
  subject: string,
) {
  const list = await ctx.db.get(id as Id<"lists">);
  if (!list) {
    throw new ConvexError("Parent object is outside the authorized workspace");
  }
  if (list.parentType === "space") {
    await requireReadableSpace(ctx, list.parentId, workspace, subject);
  } else if (list.parentType === "project") {
    await requireReadableProject(ctx, list.parentId, workspace, subject);
  } else {
    const folder = await ctx.db.get(list.parentId as Id<"folders">);
    if (!folder) {
      throw new ConvexError(
        "Parent object is outside the authorized workspace",
      );
    }
    await requireReadableSpace(ctx, folder.spaceId, workspace, subject);
  }
  return list;
}

function snapshotObject(
  objectType:
    | "workspace"
    | "space"
    | "project"
    | "list"
    | "task"
    | "agent"
    | "run",
  id: string,
  sourcePath: string,
  data: Record<string, unknown>,
) {
  return {
    objectType,
    externalId: `operate:${objectType}:${id}`,
    version: sha256Hex(JSON.stringify({ objectType, id, sourcePath, data })),
    sourcePath,
    data,
  };
}

type UnstampedSnapshotObject = ReturnType<typeof snapshotObject>;
type UnstampedSnapshotResult = {
  page: UnstampedSnapshotObject[];
  isDone: boolean;
  continueCursor: string;
};

/**
 * Most legacy Operate object tables have a creation time but no reliable
 * modification time. Record the moment this provider first observes a content
 * version instead of fabricating a source timestamp. The value is stable for
 * an unchanged version and strictly increases when that version changes.
 */
async function stampSnapshotResult(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  result: UnstampedSnapshotResult,
) {
  const observedAt = Date.now();
  const page: Array<UnstampedSnapshotObject & { updatedAt: number }> = [];
  for (const object of result.page) {
    const existing = await ctx.db
      .query("companyOsObjectVersions")
      .withIndex("by_workspace_and_external_id", (q) =>
        q.eq("workspaceId", workspaceId).eq("externalId", object.externalId),
      )
      .unique();
    let updatedAt: number;
    if (existing?.version === object.version) {
      updatedAt = existing.updatedAt;
    } else {
      updatedAt = Math.max(observedAt, (existing?.updatedAt ?? 0) + 1);
      if (existing) {
        await ctx.db.patch(existing._id, {
          version: object.version,
          updatedAt,
        });
      } else {
        await ctx.db.insert("companyOsObjectVersions", {
          workspaceId,
          externalId: object.externalId,
          version: object.version,
          updatedAt,
        });
      }
    }
    page.push({ ...object, updatedAt });
  }
  return { ...result, page };
}

function requireParent(
  actual: string | undefined,
  expected: string | string[],
  parentId: string | undefined,
) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!actual || !allowed.includes(actual) || !parentId) {
    throw new ConvexError(
      `parent_type=${allowed.join("|")} and parent_id are required`,
    );
  }
  return parentId;
}

export const account = internalQuery({
  args: { accessTokenHash: v.string(), resource: v.string() },
  returns: v.object({
    providerId: v.literal("operate"),
    subject: v.string(),
    oauthClientId: v.string(),
    scopes: v.array(v.string()),
    workspace: v.object({
      externalId: v.string(),
      name: v.string(),
      slug: v.string(),
      role: v.union(v.literal("owner"), v.literal("admin")),
      sourcePath: v.string(),
    }),
  }),
  handler: async (ctx, args) => {
    const auth = await requireConnectorToken(
      ctx,
      args.accessTokenHash,
      args.resource,
      "companyos:account:read",
    );
    if (auth.membership.role === "member") {
      throw new ConvexError("Company OS access is no longer authorized");
    }
    return {
      providerId: "operate" as const,
      subject: auth.token.userClerkId,
      oauthClientId: auth.token.clientId,
      scopes: auth.token.scopes,
      workspace: {
        externalId: `operate:workspace:${auth.workspace._id}`,
        name: auth.workspace.name,
        slug: auth.workspace.slug,
        role: auth.membership.role,
        sourcePath: `/dashboard/w/${auth.workspace._id}`,
      },
    };
  },
});

export const snapshot = internalMutation({
  args: {
    accessTokenHash: v.string(),
    resource: v.string(),
    objectType: objectTypeValidator,
    parentType: parentTypeValidator,
    parentId: v.optional(v.string()),
    legacy: v.optional(v.boolean()),
    paginationOpts: paginationOptsValidator,
  },
  returns: snapshotResultValidator,
  handler: async (ctx, args) => {
    if (
      !Number.isInteger(args.paginationOpts.numItems) ||
      args.paginationOpts.numItems < 1 ||
      args.paginationOpts.numItems > MAX_PAGE_SIZE
    ) {
      throw new ConvexError(`Page size must be between 1 and ${MAX_PAGE_SIZE}`);
    }
    const auth = await requireConnectorToken(
      ctx,
      args.accessTokenHash,
      args.resource,
      "companyos:data:read",
      true,
    );
    const subject = auth.token.userClerkId;
    const finish = (result: UnstampedSnapshotResult) =>
      stampSnapshotResult(ctx, auth.workspace._id, result);

    if (args.objectType === "workspace") {
      if (args.parentType || args.parentId) {
        throw new ConvexError("Workspace snapshots do not accept a parent");
      }
      if (args.paginationOpts.cursor !== null) {
        return await finish({
          page: [],
          isDone: true,
          continueCursor: "workspace:end",
        });
      }
      const workspace = auth.workspace;
      return await finish({
        page: [
          snapshotObject(
            "workspace",
            workspace._id,
            `/dashboard/w/${workspace._id}`,
            {
              name: workspace.name,
              slug: workspace.slug,
              created_at: workspace.createdAt,
            },
          ),
        ],
        isDone: true,
        continueCursor: "workspace:end",
      });
    }

    if (args.objectType === "space") {
      if (args.parentType || args.parentId) {
        throw new ConvexError("Space snapshots use the authorized workspace");
      }
      const page = await ctx.db
        .query("spaces")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "workspace").eq("parentId", auth.workspace._id),
        )
        .paginate(args.paginationOpts);
      return await finish({
        isDone: page.isDone,
        continueCursor: page.continueCursor,
        page: page.page
          .filter((space) => mayReadSpace(space, auth.workspace, subject))
          .map((space) =>
            snapshotObject("space", space._id, `/dashboard/s/${space._id}`, {
              name: space.name,
              description: space.description ?? null,
              color: space.color ?? null,
              private: space.private ?? false,
              archived_at: space.archivedAt ?? null,
              created_at: space.createdAt,
            }),
          ),
      });
    }

    if (args.objectType === "project") {
      const spaceId = requireParent(args.parentType, "space", args.parentId);
      await requireReadableSpace(ctx, spaceId, auth.workspace, subject);
      if (args.legacy) {
        const page = await ctx.db
          .query("folders")
          .withIndex("by_space", (q) =>
            q.eq("spaceId", spaceId as Id<"spaces">),
          )
          .paginate(args.paginationOpts);
        return await finish({
          isDone: page.isDone,
          continueCursor: page.continueCursor,
          page: page.page.map((folder) =>
            snapshotObject(
              "project",
              folder._id,
              `/dashboard/s/${folder.spaceId}`,
              {
                space_external_id: `operate:space:${folder.spaceId}`,
                name: folder.name,
                legacy_folder: true,
                created_at: folder.createdAt,
              },
            ),
          ),
        });
      }
      const page = await ctx.db
        .query("projects")
        .withIndex("by_space", (q) => q.eq("spaceId", spaceId as Id<"spaces">))
        .paginate(args.paginationOpts);
      return await finish({
        isDone: page.isDone,
        continueCursor: page.continueCursor,
        page: page.page.map((project) =>
          snapshotObject(
            "project",
            project._id,
            `/dashboard/p/${project._id}`,
            {
              space_external_id: `operate:space:${project.spaceId}`,
              name: project.name,
              description: project.description ?? null,
              status: project.projectStatus ?? null,
              notes: project.notes ?? null,
              target_date: project.targetDate ?? null,
              archived_at: project.archivedAt ?? null,
              created_at: project.createdAt,
            },
          ),
        ),
      });
    }

    if (args.objectType === "list") {
      const parentId = requireParent(
        args.parentType,
        ["space", "project", "folder"],
        args.parentId,
      );
      const listParentType =
        args.parentType === "space"
          ? ("space" as const)
          : args.parentType === "folder"
            ? ("folder" as const)
            : ("project" as const);
      if (listParentType === "space") {
        await requireReadableSpace(ctx, parentId, auth.workspace, subject);
      } else if (listParentType === "project") {
        await requireReadableProject(ctx, parentId, auth.workspace, subject);
      } else {
        const folder = await ctx.db.get(parentId as Id<"folders">);
        if (!folder) {
          throw new ConvexError(
            "Parent object is outside the authorized workspace",
          );
        }
        await requireReadableSpace(
          ctx,
          folder.spaceId,
          auth.workspace,
          subject,
        );
      }
      const page = await ctx.db
        .query("lists")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", listParentType).eq("parentId", parentId),
        )
        .paginate(args.paginationOpts);
      return await finish({
        isDone: page.isDone,
        continueCursor: page.continueCursor,
        page: page.page.map((list) =>
          snapshotObject("list", list._id, `/dashboard/l/${list._id}`, {
            parent_external_id:
              list.parentType === "folder"
                ? `operate:project:${list.parentId}`
                : `operate:${list.parentType}:${list.parentId}`,
            name: list.name,
            description: list.description ?? null,
            project_status: list.projectStatus ?? null,
            notes: list.notes ?? null,
            target_date: list.targetDate ?? null,
            created_at: list.createdAt,
          }),
        ),
      });
    }

    if (args.objectType === "task") {
      const listId = requireParent(args.parentType, "list", args.parentId);
      await requireReadableList(ctx, listId, auth.workspace, subject);
      const page = await ctx.db
        .query("tasks")
        .withIndex("by_list", (q) => q.eq("listId", listId as Id<"lists">))
        .paginate(args.paginationOpts);
      return await finish({
        isDone: page.isDone,
        continueCursor: page.continueCursor,
        page: page.page.map((task) =>
          snapshotObject(
            "task",
            task._id,
            `/dashboard/l/${task.listId}/t/${task._id}`,
            {
              list_external_id: `operate:list:${task.listId}`,
              title: task.title,
              description: task.description ?? null,
              status_external_id: `operate:list_status:${task.statusId}`,
              priority: task.priority ?? null,
              start_date: task.startDate ?? null,
              due_date: task.dueDate ?? null,
              completed_at: task.completedAt ?? null,
              assignee_external_ids: task.assigneeClerkIds,
              requires_approval: task.requiresApproval ?? false,
              approved_at: task.approvedAt ?? null,
              required_capabilities: task.requiredCapabilities ?? [],
              created_at: task.createdAt,
            },
          ),
        ),
      });
    }

    if (args.objectType === "agent") {
      if (args.parentType || args.parentId) {
        throw new ConvexError("Agent snapshots use the authorized workspace");
      }
      const page = await ctx.db
        .query("agents")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "workspace").eq("parentId", auth.workspace._id),
        )
        .paginate(args.paginationOpts);
      return await finish({
        isDone: page.isDone,
        continueCursor: page.continueCursor,
        page: page.page.map((agent) =>
          snapshotObject("agent", agent._id, `/dashboard/agents/${agent._id}`, {
            name: agent.name,
            description: agent.description ?? null,
            status: agent.status,
            role: agent.role ?? "member",
            capabilities: agent.capabilities ?? [],
            current_task_external_id: agent.currentTaskId
              ? `operate:task:${agent.currentTaskId}`
              : null,
            last_seen_at: agent.lastSeenAt ?? null,
            created_at: agent.createdAt,
          }),
        ),
      });
    }

    const agentId = requireParent(args.parentType, "agent", args.parentId);
    const agent = await ctx.db.get(agentId as Id<"agents">);
    if (
      !agent ||
      agent.parentType !== "workspace" ||
      agent.parentId !== auth.workspace._id
    ) {
      throw new ConvexError(
        "Parent object is outside the authorized workspace",
      );
    }
    const page = await ctx.db
      .query("agentRuns")
      .withIndex("by_agent", (q) => q.eq("agentId", agent._id))
      .paginate(args.paginationOpts);
    return await finish({
      isDone: page.isDone,
      continueCursor: page.continueCursor,
      page: page.page.map((run) =>
        snapshotObject("run", run._id, `/dashboard/agents/${agent._id}`, {
          agent_external_id: `operate:agent:${run.agentId}`,
          task_external_id: run.taskId ? `operate:task:${run.taskId}` : null,
          title: run.title,
          status: run.status,
          summary: run.summary ?? null,
          error: run.error ?? null,
          links: run.links ?? [],
          tokens_used: run.tokensUsed ?? null,
          cost_usd: run.costUsd ?? null,
          started_at: run.startedAt,
          finished_at: run.finishedAt ?? null,
        }),
      ),
    });
  },
});

export const currentInstallation = internalQuery({
  args: { accessTokenHash: v.string(), resource: v.string() },
  returns: v.union(installationValidator, v.null()),
  handler: async (ctx, args) => {
    const auth = await requireConnectorToken(
      ctx,
      args.accessTokenHash,
      args.resource,
      "companyos:account:read",
    );
    const row = await ctx.db
      .query("companyOsInstallations")
      .withIndex("by_workspace_and_client_and_status", (q) =>
        q
          .eq("workspaceId", auth.workspace._id)
          .eq("oauthClientId", auth.token.clientId)
          .eq("status", "active"),
      )
      .first();
    if (!row) return null;
    if (
      row.oauthSubject !== auth.token.userClerkId ||
      row.oauthGrantId !== auth.token.grantId
    ) {
      return null;
    }
    return installationResult(row);
  },
});

export const upsertInstallation = internalMutation({
  args: {
    accessTokenHash: v.string(),
    resource: v.string(),
    externalInstallationId: v.string(),
  },
  returns: installationValidator,
  handler: async (ctx, args) => {
    const auth = await requireConnectorToken(
      ctx,
      args.accessTokenHash,
      args.resource,
      "companyos:account:read",
    );
    if (!auth.token.scopes.includes("companyos:data:read")) {
      throw new ConvexError(
        "Company OS access token is missing required scope",
      );
    }
    const externalInstallationId = args.externalInstallationId.trim();
    const oauthGrantId = auth.token.grantId;
    if (!oauthGrantId) {
      throw new ConvexError("Company OS access is no longer authorized");
    }
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(externalInstallationId)) {
      throw new ConvexError("external_installation_id has an invalid format");
    }
    const now = Date.now();
    const workspaceBindings = await ctx.db
      .query("companyOsInstallations")
      .withIndex("by_workspace_and_client", (q) =>
        q
          .eq("workspaceId", auth.workspace._id)
          .eq("oauthClientId", auth.token.clientId),
      )
      .take(2);
    if (
      workspaceBindings.length > 1 ||
      workspaceBindings.some(
        (binding) => binding.externalInstallationId !== externalInstallationId,
      )
    ) {
      throw new ConvexError(
        "This workspace is already bound to a different installation identity",
      );
    }
    const existing = await ctx.db
      .query("companyOsInstallations")
      .withIndex("by_external_installation_id", (q) =>
        q.eq("externalInstallationId", externalInstallationId),
      )
      .unique();
    if (existing) {
      if (
        existing.workspaceId !== auth.workspace._id ||
        existing.oauthClientId !== auth.token.clientId
      ) {
        throw new ConvexError("Installation identity is already in use");
      }
      if (
        existing.oauthGrantId !== oauthGrantId &&
        existing.status === "active"
      ) {
        throw new ConvexError(
          "The active installation belongs to a different OAuth grant",
        );
      }
      if (
        existing.oauthGrantId !== oauthGrantId &&
        ((existing.disconnectedAt !== undefined &&
          auth.token.createdAt <= existing.disconnectedAt) ||
          (existing.oauthRevokedBefore !== undefined &&
            auth.token.createdAt <= existing.oauthRevokedBefore))
      ) {
        throw new ConvexError(
          "A fresh OAuth grant is required to reactivate this installation",
        );
      }
      const replacement = {
        externalInstallationId,
        workspaceId: auth.workspace._id,
        oauthSubject: auth.token.userClerkId,
        oauthClientId: auth.token.clientId,
        oauthGrantId,
        scopes: auth.token.scopes,
        status: "active" as const,
        installedAt: existing.installedAt,
        updatedAt: now,
        ...(existing.oauthRevokedBefore === undefined
          ? {}
          : { oauthRevokedBefore: existing.oauthRevokedBefore }),
      };
      await ctx.db.replace(existing._id, replacement);
      return installationResult(replacement);
    }
    const created = {
      externalInstallationId,
      workspaceId: auth.workspace._id,
      oauthSubject: auth.token.userClerkId,
      oauthClientId: auth.token.clientId,
      oauthGrantId,
      scopes: auth.token.scopes,
      status: "active" as const,
      installedAt: now,
      updatedAt: now,
    };
    await ctx.db.insert("companyOsInstallations", created);
    return installationResult(created);
  },
});

export const disconnectInstallation = internalMutation({
  args: {
    accessTokenHash: v.string(),
    resource: v.string(),
    externalInstallationId: v.string(),
  },
  returns: v.object({ disconnected: v.boolean(), tokenRevoked: v.boolean() }),
  handler: async (ctx, args) => {
    const requestedInstallationId = args.externalInstallationId.trim();
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(requestedInstallationId)) {
      throw new ConvexError("external_installation_id has an invalid format");
    }

    // A response can disappear after the disconnect commits. The now-revoked
    // bearer may retry only the exact cleanup receipt it created; it cannot be
    // used for reads, a different installation id, or a newer binding.
    const priorToken = await ctx.db
      .query("oauthAccessTokens")
      .withIndex("by_token_hash", (q) =>
        q.eq("tokenHash", args.accessTokenHash),
      )
      .unique();
    const priorBinding = await ctx.db
      .query("companyOsInstallations")
      .withIndex("by_external_installation_id", (q) =>
        q.eq("externalInstallationId", requestedInstallationId),
      )
      .unique();
    if (
      priorToken &&
      priorBinding?.status === "disconnected" &&
      priorToken.resource === requireCompanyOsResource(args.resource) &&
      priorToken.scopes.includes("companyos:account:read") &&
      priorToken.workspaceId === priorBinding.workspaceId &&
      priorToken.clientId === priorBinding.oauthClientId &&
      priorToken.userClerkId === priorBinding.oauthSubject &&
      priorToken.grantId === priorBinding.oauthGrantId
    ) {
      return { disconnected: true, tokenRevoked: true };
    }

    const auth = await requireConnectorToken(
      ctx,
      args.accessTokenHash,
      args.resource,
      "companyos:account:read",
    );
    const active = await ctx.db
      .query("companyOsInstallations")
      .withIndex("by_workspace_and_client_and_status", (q) =>
        q
          .eq("workspaceId", auth.workspace._id)
          .eq("oauthClientId", auth.token.clientId)
          .eq("status", "active"),
      )
      .first();
    if (active && active.externalInstallationId !== requestedInstallationId) {
      throw new ConvexError("Active installation was not found");
    }
    const now = Date.now();
    if (
      active &&
      (active.oauthSubject !== auth.token.userClerkId ||
        active.oauthGrantId !== auth.token.grantId)
    ) {
      throw new ConvexError("Active installation was not found");
    }
    if (active) {
      await ctx.db.patch(active._id, {
        status: "disconnected",
        disconnectedAt: now,
        oauthRevokedBefore: now,
        updatedAt: now,
      });
    } else {
      const workspaceBindings = await ctx.db
        .query("companyOsInstallations")
        .withIndex("by_workspace_and_client", (q) =>
          q
            .eq("workspaceId", auth.workspace._id)
            .eq("oauthClientId", auth.token.clientId),
        )
        .take(2);
      if (
        workspaceBindings.length > 1 ||
        workspaceBindings.some(
          (binding) =>
            binding.externalInstallationId !== requestedInstallationId,
        )
      ) {
        throw new ConvexError("Active installation was not found");
      }
      const existing = await ctx.db
        .query("companyOsInstallations")
        .withIndex("by_external_installation_id", (q) =>
          q.eq("externalInstallationId", requestedInstallationId),
        )
        .unique();
      if (
        existing &&
        (existing.workspaceId !== auth.workspace._id ||
          existing.oauthClientId !== auth.token.clientId)
      ) {
        throw new ConvexError("Active installation was not found");
      }
      const cleanupReceipt = {
        externalInstallationId: requestedInstallationId,
        workspaceId: auth.workspace._id,
        oauthSubject: auth.token.userClerkId,
        oauthClientId: auth.token.clientId,
        oauthGrantId: auth.token.grantId!,
        scopes: auth.token.scopes,
        status: "disconnected" as const,
        installedAt: existing?.installedAt ?? now,
        updatedAt: now,
        disconnectedAt: now,
        oauthRevokedBefore: now,
      };
      if (existing) {
        await ctx.db.replace(existing._id, cleanupReceipt);
      } else {
        await ctx.db.insert("companyOsInstallations", cleanupReceipt);
      }
    }
    if (auth.token.grantId) {
      const grant = await ctx.db
        .query("oauthTokenGrants")
        .withIndex("by_grant_id", (q) => q.eq("grantId", auth.token.grantId!))
        .unique();
      if (grant && grant.revokedAt === undefined) {
        await ctx.db.patch(grant._id, {
          revokedAt: now,
          updatedAt: now,
          revocationReason: "installation_disconnected",
        });
      }
    }
    await ctx.db.patch(auth.token._id, { revokedAt: now });
    return {
      disconnected: true,
      tokenRevoked: true,
    };
  },
});
