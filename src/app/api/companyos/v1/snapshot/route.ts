import { randomBytes } from "node:crypto";
import {
  bearerAccessToken,
  companyOsBackend,
  companyOsAuthError,
  companyOsJson,
  companyOsRouteError,
  type CompanyOsObjectType,
  type CompanyOsParentType,
  type ConnectorSnapshot,
  type ConnectorSnapshotObject,
} from "@/lib/companyos-connect";
import {
  decodeCompanyOsSnapshotCursor,
  encodeCompanyOsSnapshotCursor,
  companyOsSnapshotCursorBinding,
  initialCompanyOsSnapshotCursor,
  type CompanyOsSnapshotCursor,
} from "@/lib/companyos-snapshot-cursor";
import {
  companyOsOAuthResource,
  oauthIssuer,
} from "@/lib/oauth-server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;
const MAX_CONVEX_READS_PER_REQUEST = 50;

type Parent = { type: CompanyOsParentType; id: string };

function pageSize(value: string | null) {
  if (!value) return DEFAULT_PAGE_SIZE;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(parsed)));
}

function resetCursor(
  phase: CompanyOsSnapshotCursor["phase"],
  checkpoint: string,
): CompanyOsSnapshotCursor {
  return { ...initialCompanyOsSnapshotCursor(), phase, checkpoint };
}

function providerId(object: ConnectorSnapshotObject) {
  const prefix = `operate:${object.objectType}:`;
  if (!object.externalId.startsWith(prefix)) {
    throw new Error("Provider returned an invalid object identity");
  }
  return object.externalId.slice(prefix.length);
}

async function readSnapshotPage(
  accessToken: string,
  objectType: CompanyOsObjectType,
  limit: number,
  cursor: string | null | undefined,
  parent?: Parent,
  legacy = false,
): Promise<ConnectorSnapshot> {
  return companyOsBackend<ConnectorSnapshot>("snapshot", accessToken, {
    resource: companyOsOAuthResource(),
    objectType,
    ...(parent ? { parentType: parent.type, parentId: parent.id } : {}),
    ...(legacy ? { legacy: true } : {}),
    paginationOpts: { numItems: limit, cursor: cursor ?? null },
  });
}

function publicObject(object: ConnectorSnapshotObject, issuer: string) {
  const source = new URL(object.sourcePath, issuer);
  return {
    type: object.objectType,
    id: object.externalId,
    version: object.version,
    updatedAt: new Date(object.updatedAt).toISOString(),
    ...(source.protocol === "https:" ? { sourceUrl: source.toString() } : {}),
    data: object.data,
  };
}

export async function GET(request: Request) {
  const accessToken = bearerAccessToken(request);
  if (!accessToken) {
    return companyOsAuthError("A Bearer access token is required");
  }
  const url = new URL(request.url);
  const limit = pageSize(url.searchParams.get("limit"));
  const cursorBinding = companyOsSnapshotCursorBinding(accessToken);
  let state: CompanyOsSnapshotCursor;
  try {
    state = decodeCompanyOsSnapshotCursor(
      url.searchParams.get("cursor"),
      cursorBinding,
    );
    state.checkpoint ??= randomBytes(18).toString("base64url");
  } catch (error) {
    return companyOsJson(
      {
        error: "invalid_request",
        error_description:
          error instanceof Error ? error.message : "cursor is invalid",
      },
      400,
    );
  }

  const objects: ConnectorSnapshotObject[] = [];
  let reads = 0;

  const read = async (
    objectType: CompanyOsObjectType,
    size: number,
    cursor: string | null | undefined,
    parent?: Parent,
    legacy = false,
  ) => {
    reads += 1;
    return readSnapshotPage(
      accessToken,
      objectType,
      size,
      cursor,
      parent,
      legacy,
    );
  };

  try {
    while (
      objects.length < limit &&
      state.phase !== "done" &&
      reads < MAX_CONVEX_READS_PER_REQUEST
    ) {
      const remaining = limit - objects.length;

      if (state.phase === "workspace") {
        const page = await read("workspace", 1, null);
        objects.push(...page.page);
        state = resetCursor("spaces", state.checkpoint!);
        continue;
      }

      if (state.phase === "spaces") {
        const page = await read("space", remaining, state.cursor);
        objects.push(...page.page);
        state.cursor = page.continueCursor;
        if (page.isDone) state = resetCursor("projects", state.checkpoint!);
        continue;
      }

      if (state.phase === "projects") {
        if (!state.spaceId) {
          if (state.spaceDone) {
            state = resetCursor("legacy_projects", state.checkpoint!);
            continue;
          }
          const parents = await read("space", 1, state.spaceCursor);
          state.spaceCursor = parents.continueCursor;
          state.spaceDone = parents.isDone;
          const parent = parents.page[0];
          if (!parent) continue;
          state.spaceId = providerId(parent);
          state.childCursor = null;
        }
        const page = await read(
          "project",
          remaining,
          state.childCursor,
          { type: "space", id: state.spaceId },
        );
        objects.push(...page.page);
        state.childCursor = page.continueCursor;
        if (page.isDone) {
          delete state.spaceId;
          delete state.childCursor;
        }
        continue;
      }

      if (state.phase === "legacy_projects") {
        if (!state.spaceId) {
          if (state.spaceDone) {
            state = resetCursor("space_lists", state.checkpoint!);
            continue;
          }
          const parents = await read("space", 1, state.spaceCursor);
          state.spaceCursor = parents.continueCursor;
          state.spaceDone = parents.isDone;
          const parent = parents.page[0];
          if (!parent) continue;
          state.spaceId = providerId(parent);
          state.childCursor = null;
        }
        const page = await read(
          "project",
          remaining,
          state.childCursor,
          { type: "space", id: state.spaceId },
          true,
        );
        objects.push(...page.page);
        state.childCursor = page.continueCursor;
        if (page.isDone) {
          delete state.spaceId;
          delete state.childCursor;
        }
        continue;
      }

      if (state.phase === "space_lists") {
        if (!state.spaceId) {
          if (state.spaceDone) {
            state = resetCursor("project_lists", state.checkpoint!);
            continue;
          }
          const parents = await read("space", 1, state.spaceCursor);
          state.spaceCursor = parents.continueCursor;
          state.spaceDone = parents.isDone;
          const parent = parents.page[0];
          if (!parent) continue;
          state.spaceId = providerId(parent);
          state.childCursor = null;
        }
        const page = await read("list", remaining, state.childCursor, {
          type: "space",
          id: state.spaceId,
        });
        objects.push(...page.page);
        state.childCursor = page.continueCursor;
        if (page.isDone) {
          delete state.spaceId;
          delete state.childCursor;
        }
        continue;
      }

      if (state.phase === "project_lists") {
        if (!state.spaceId) {
          if (state.spaceDone) {
            state = resetCursor("folder_lists", state.checkpoint!);
            continue;
          }
          const spaces = await read("space", 1, state.spaceCursor);
          state.spaceCursor = spaces.continueCursor;
          state.spaceDone = spaces.isDone;
          const space = spaces.page[0];
          if (!space) continue;
          state.spaceId = providerId(space);
          state.projectCursor = null;
          state.projectDone = false;
        }
        if (!state.projectId) {
          if (state.projectDone) {
            delete state.spaceId;
            continue;
          }
          const projects = await read("project", 1, state.projectCursor, {
            type: "space",
            id: state.spaceId,
          });
          state.projectCursor = projects.continueCursor;
          state.projectDone = projects.isDone;
          const project = projects.page[0];
          if (!project) continue;
          state.projectId = providerId(project);
          state.childCursor = null;
        }
        const page = await read("list", remaining, state.childCursor, {
          type: "project",
          id: state.projectId,
        });
        objects.push(...page.page);
        state.childCursor = page.continueCursor;
        if (page.isDone) {
          delete state.projectId;
          delete state.childCursor;
        }
        continue;
      }

      if (state.phase === "folder_lists") {
        if (!state.spaceId) {
          if (state.spaceDone) {
            state = resetCursor("space_tasks", state.checkpoint!);
            continue;
          }
          const spaces = await read("space", 1, state.spaceCursor);
          state.spaceCursor = spaces.continueCursor;
          state.spaceDone = spaces.isDone;
          const space = spaces.page[0];
          if (!space) continue;
          state.spaceId = providerId(space);
          state.projectCursor = null;
          state.projectDone = false;
        }
        if (!state.projectId) {
          if (state.projectDone) {
            delete state.spaceId;
            continue;
          }
          const folders = await read(
            "project",
            1,
            state.projectCursor,
            { type: "space", id: state.spaceId },
            true,
          );
          state.projectCursor = folders.continueCursor;
          state.projectDone = folders.isDone;
          const folder = folders.page[0];
          if (!folder) continue;
          state.projectId = providerId(folder);
          state.childCursor = null;
        }
        const page = await read("list", remaining, state.childCursor, {
          type: "folder",
          id: state.projectId,
        });
        objects.push(...page.page);
        state.childCursor = page.continueCursor;
        if (page.isDone) {
          delete state.projectId;
          delete state.childCursor;
        }
        continue;
      }

      if (state.phase === "space_tasks") {
        if (!state.spaceId) {
          if (state.spaceDone) {
            state = resetCursor("project_tasks", state.checkpoint!);
            continue;
          }
          const spaces = await read("space", 1, state.spaceCursor);
          state.spaceCursor = spaces.continueCursor;
          state.spaceDone = spaces.isDone;
          const space = spaces.page[0];
          if (!space) continue;
          state.spaceId = providerId(space);
          state.listCursor = null;
          state.listDone = false;
        }
        if (!state.listId) {
          if (state.listDone) {
            delete state.spaceId;
            continue;
          }
          const lists = await read("list", 1, state.listCursor, {
            type: "space",
            id: state.spaceId,
          });
          state.listCursor = lists.continueCursor;
          state.listDone = lists.isDone;
          const list = lists.page[0];
          if (!list) continue;
          state.listId = providerId(list);
          state.childCursor = null;
        }
        const page = await read("task", remaining, state.childCursor, {
          type: "list",
          id: state.listId,
        });
        objects.push(...page.page);
        state.childCursor = page.continueCursor;
        if (page.isDone) {
          delete state.listId;
          delete state.childCursor;
        }
        continue;
      }

      if (state.phase === "project_tasks") {
        if (!state.spaceId) {
          if (state.spaceDone) {
            state = resetCursor("folder_tasks", state.checkpoint!);
            continue;
          }
          const spaces = await read("space", 1, state.spaceCursor);
          state.spaceCursor = spaces.continueCursor;
          state.spaceDone = spaces.isDone;
          const space = spaces.page[0];
          if (!space) continue;
          state.spaceId = providerId(space);
          state.projectCursor = null;
          state.projectDone = false;
        }
        if (!state.projectId) {
          if (state.projectDone) {
            delete state.spaceId;
            continue;
          }
          const projects = await read("project", 1, state.projectCursor, {
            type: "space",
            id: state.spaceId,
          });
          state.projectCursor = projects.continueCursor;
          state.projectDone = projects.isDone;
          const project = projects.page[0];
          if (!project) continue;
          state.projectId = providerId(project);
          state.listCursor = null;
          state.listDone = false;
        }
        if (!state.listId) {
          if (state.listDone) {
            delete state.projectId;
            continue;
          }
          const lists = await read("list", 1, state.listCursor, {
            type: "project",
            id: state.projectId,
          });
          state.listCursor = lists.continueCursor;
          state.listDone = lists.isDone;
          const list = lists.page[0];
          if (!list) continue;
          state.listId = providerId(list);
          state.childCursor = null;
        }
        const page = await read("task", remaining, state.childCursor, {
          type: "list",
          id: state.listId,
        });
        objects.push(...page.page);
        state.childCursor = page.continueCursor;
        if (page.isDone) {
          delete state.listId;
          delete state.childCursor;
        }
        continue;
      }

      if (state.phase === "folder_tasks") {
        if (!state.spaceId) {
          if (state.spaceDone) {
            state = resetCursor("agents", state.checkpoint!);
            continue;
          }
          const spaces = await read("space", 1, state.spaceCursor);
          state.spaceCursor = spaces.continueCursor;
          state.spaceDone = spaces.isDone;
          const space = spaces.page[0];
          if (!space) continue;
          state.spaceId = providerId(space);
          state.projectCursor = null;
          state.projectDone = false;
        }
        if (!state.projectId) {
          if (state.projectDone) {
            delete state.spaceId;
            continue;
          }
          const folders = await read(
            "project",
            1,
            state.projectCursor,
            { type: "space", id: state.spaceId },
            true,
          );
          state.projectCursor = folders.continueCursor;
          state.projectDone = folders.isDone;
          const folder = folders.page[0];
          if (!folder) continue;
          state.projectId = providerId(folder);
          state.listCursor = null;
          state.listDone = false;
        }
        if (!state.listId) {
          if (state.listDone) {
            delete state.projectId;
            continue;
          }
          const lists = await read("list", 1, state.listCursor, {
            type: "folder",
            id: state.projectId,
          });
          state.listCursor = lists.continueCursor;
          state.listDone = lists.isDone;
          const list = lists.page[0];
          if (!list) continue;
          state.listId = providerId(list);
          state.childCursor = null;
        }
        const page = await read("task", remaining, state.childCursor, {
          type: "list",
          id: state.listId,
        });
        objects.push(...page.page);
        state.childCursor = page.continueCursor;
        if (page.isDone) {
          delete state.listId;
          delete state.childCursor;
        }
        continue;
      }

      if (state.phase === "agents") {
        const page = await read("agent", remaining, state.cursor);
        objects.push(...page.page);
        state.cursor = page.continueCursor;
        if (page.isDone) state = resetCursor("runs", state.checkpoint!);
        continue;
      }

      if (state.phase === "runs") {
        if (!state.agentId) {
          if (state.agentDone) {
            state = resetCursor("done", state.checkpoint!);
            continue;
          }
          const agents = await read("agent", 1, state.agentCursor);
          state.agentCursor = agents.continueCursor;
          state.agentDone = agents.isDone;
          const agent = agents.page[0];
          if (!agent) continue;
          state.agentId = providerId(agent);
          state.childCursor = null;
        }
        const page = await read("run", remaining, state.childCursor, {
          type: "agent",
          id: state.agentId,
        });
        objects.push(...page.page);
        state.childCursor = page.continueCursor;
        if (page.isDone) {
          delete state.agentId;
          delete state.childCursor;
        }
      }
    }

    return companyOsJson({
      objects: objects.map((object) => publicObject(object, oauthIssuer())),
      nextCursor:
        state.phase === "done"
          ? null
          : encodeCompanyOsSnapshotCursor(state, cursorBinding),
      checkpoint: state.checkpoint,
    });
  } catch (error) {
    return companyOsRouteError(error);
  }
}
