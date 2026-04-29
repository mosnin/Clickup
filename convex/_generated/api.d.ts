/* prettier-ignore-start */
/* eslint-disable */
//
// Generated `api` references for Convex's data model.
//
// This file is initially hand-rolled to keep the Next.js side compiling
// before `npx convex dev` has been run. Convex will overwrite it with the
// real generated output as soon as the dev/deploy CLI runs.

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import type * as _authz from "../_authz.js";
import type * as customFields from "../customFields.js";
import type * as docs from "../docs.js";
import type * as folders from "../folders.js";
import type * as http from "../http.js";
import type * as listStatuses from "../listStatuses.js";
import type * as lists from "../lists.js";
import type * as mentions from "../mentions.js";
import type * as messages from "../messages.js";
import type * as sidebar from "../sidebar.js";
import type * as spaces from "../spaces.js";
import type * as taskFieldValues from "../taskFieldValues.js";
import type * as tasks from "../tasks.js";
import type * as users from "../users.js";
import type * as whiteboards from "../whiteboards.js";
import type * as workspaces from "../workspaces.js";

declare const fullApi: ApiFromModules<{
  _authz: typeof _authz;
  customFields: typeof customFields;
  docs: typeof docs;
  folders: typeof folders;
  http: typeof http;
  listStatuses: typeof listStatuses;
  lists: typeof lists;
  mentions: typeof mentions;
  messages: typeof messages;
  sidebar: typeof sidebar;
  spaces: typeof spaces;
  taskFieldValues: typeof taskFieldValues;
  tasks: typeof tasks;
  users: typeof users;
  whiteboards: typeof whiteboards;
  workspaces: typeof workspaces;
}>;

export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

/* prettier-ignore-end */
