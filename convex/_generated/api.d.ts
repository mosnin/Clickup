/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as _adminAuth from "../_adminAuth.js";
import type * as _agentAuth from "../_agentAuth.js";
import type * as _authz from "../_authz.js";
import type * as _x402 from "../_x402.js";
import type * as admin from "../admin.js";
import type * as agentAi from "../agentAi.js";
import type * as agentApi from "../agentApi.js";
import type * as agentKeys from "../agentKeys.js";
import type * as agentTemplates from "../agentTemplates.js";
import type * as agents from "../agents.js";
import type * as ai from "../ai.js";
import type * as aiDb from "../aiDb.js";
import type * as attachments from "../attachments.js";
import type * as channels from "../channels.js";
import type * as checklistTemplates from "../checklistTemplates.js";
import type * as clips from "../clips.js";
import type * as crons from "../crons.js";
import type * as customFields from "../customFields.js";
import type * as dataExport from "../dataExport.js";
import type * as docs from "../docs.js";
import type * as events from "../events.js";
import type * as favorites from "../favorites.js";
import type * as folders from "../folders.js";
import type * as forms from "../forms.js";
import type * as goals from "../goals.js";
import type * as homeOverview from "../homeOverview.js";
import type * as http from "../http.js";
import type * as importer from "../importer.js";
import type * as integrations from "../integrations.js";
import type * as invites from "../invites.js";
import type * as listAutomations from "../listAutomations.js";
import type * as listStatuses from "../listStatuses.js";
import type * as lists from "../lists.js";
import type * as maintenance from "../maintenance.js";
import type * as mentions from "../mentions.js";
import type * as messages from "../messages.js";
import type * as myWork from "../myWork.js";
import type * as network from "../network.js";
import type * as notificationCenter from "../notificationCenter.js";
import type * as notifications from "../notifications.js";
import type * as onboarding from "../onboarding.js";
import type * as portfolio from "../portfolio.js";
import type * as projectsDirectory from "../projectsDirectory.js";
import type * as reports from "../reports.js";
import type * as rollups from "../rollups.js";
import type * as savedViews from "../savedViews.js";
import type * as scrumBoard from "../scrumBoard.js";
import type * as search from "../search.js";
import type * as scheduledTasks from "../scheduledTasks.js";
import type * as sidebar from "../sidebar.js";
import type * as skills from "../skills.js";
import type * as spaces from "../spaces.js";
import type * as sprintPlanning from "../sprintPlanning.js";
import type * as sprints from "../sprints.js";
import type * as taskFieldValues from "../taskFieldValues.js";
import type * as tasks from "../tasks.js";
import type * as team from "../team.js";
import type * as templates from "../templates.js";
import type * as timeEntries from "../timeEntries.js";
import type * as users from "../users.js";
import type * as webhookDelivery from "../webhookDelivery.js";
import type * as webhooks from "../webhooks.js";
import type * as whiteboards from "../whiteboards.js";
import type * as workspaces from "../workspaces.js";
import type * as x402 from "../x402.js";
import type * as x402Actions from "../x402Actions.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  _adminAuth: typeof _adminAuth;
  _agentAuth: typeof _agentAuth;
  _authz: typeof _authz;
  _x402: typeof _x402;
  admin: typeof admin;
  agentAi: typeof agentAi;
  agentApi: typeof agentApi;
  agentKeys: typeof agentKeys;
  agentTemplates: typeof agentTemplates;
  agents: typeof agents;
  ai: typeof ai;
  aiDb: typeof aiDb;
  attachments: typeof attachments;
  channels: typeof channels;
  checklistTemplates: typeof checklistTemplates;
  clips: typeof clips;
  crons: typeof crons;
  customFields: typeof customFields;
  dataExport: typeof dataExport;
  docs: typeof docs;
  events: typeof events;
  favorites: typeof favorites;
  folders: typeof folders;
  forms: typeof forms;
  goals: typeof goals;
  homeOverview: typeof homeOverview;
  http: typeof http;
  importer: typeof importer;
  integrations: typeof integrations;
  invites: typeof invites;
  listAutomations: typeof listAutomations;
  listStatuses: typeof listStatuses;
  lists: typeof lists;
  maintenance: typeof maintenance;
  mentions: typeof mentions;
  messages: typeof messages;
  myWork: typeof myWork;
  network: typeof network;
  notificationCenter: typeof notificationCenter;
  notifications: typeof notifications;
  onboarding: typeof onboarding;
  portfolio: typeof portfolio;
  projectsDirectory: typeof projectsDirectory;
  reports: typeof reports;
  rollups: typeof rollups;
  savedViews: typeof savedViews;
  scrumBoard: typeof scrumBoard;
  search: typeof search;
  scheduledTasks: typeof scheduledTasks;
  sidebar: typeof sidebar;
  skills: typeof skills;
  spaces: typeof spaces;
  sprintPlanning: typeof sprintPlanning;
  sprints: typeof sprints;
  taskFieldValues: typeof taskFieldValues;
  tasks: typeof tasks;
  team: typeof team;
  templates: typeof templates;
  timeEntries: typeof timeEntries;
  users: typeof users;
  webhookDelivery: typeof webhookDelivery;
  webhooks: typeof webhooks;
  whiteboards: typeof whiteboards;
  workspaces: typeof workspaces;
  x402: typeof x402;
  x402Actions: typeof x402Actions;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
