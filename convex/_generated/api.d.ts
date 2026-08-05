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
import type * as _customFields from "../_customFields.js";
import type * as _docText from "../_docText.js";
import type * as _docToMarkdown from "../_docToMarkdown.js";
import type * as _idempotency from "../_idempotency.js";
import type * as _markdown from "../_markdown.js";
import type * as _refs from "../_refs.js";
import type * as _scope from "../_scope.js";
import type * as _situations from "../_situations.js";
import type * as _webhookNetwork from "../_webhookNetwork.js";
import type * as _x402 from "../_x402.js";
import type * as admin from "../admin.js";
import type * as agentAi from "../agentAi.js";
import type * as agentApi from "../agentApi.js";
import type * as agentAuth from "../agentAuth.js";
import type * as agentKeys from "../agentKeys.js";
import type * as agentPingDeliveries from "../agentPingDeliveries.js";
import type * as agentPingDeliveryAction from "../agentPingDeliveryAction.js";
import type * as agentTemplates from "../agentTemplates.js";
import type * as agents from "../agents.js";
import type * as ai from "../ai.js";
import type * as aiDb from "../aiDb.js";
import type * as appearance from "../appearance.js";
import type * as attachments from "../attachments.js";
import type * as buzz__kinds from "../buzz/_kinds.js";
import type * as buzz__nostr from "../buzz/_nostr.js";
import type * as buzz__tables from "../buzz/_tables.js";
import type * as buzz_agentChat from "../buzz/agentChat.js";
import type * as buzz_agents from "../buzz/agents.js";
import type * as buzz_bridge from "../buzz/bridge.js";
import type * as buzz_canvas from "../buzz/canvas.js";
import type * as buzz_channels from "../buzz/channels.js";
import type * as buzz_forum from "../buzz/forum.js";
import type * as buzz_huddle from "../buzz/huddle.js";
import type * as buzz_identity from "../buzz/identity.js";
import type * as buzz_keys from "../buzz/keys.js";
import type * as buzz_log from "../buzz/log.js";
import type * as buzz_media from "../buzz/media.js";
import type * as buzz_messages from "../buzz/messages.js";
import type * as buzz_moderation from "../buzz/moderation.js";
import type * as buzz_notifications from "../buzz/notifications.js";
import type * as buzz_presence from "../buzz/presence.js";
import type * as buzz_projects from "../buzz/projects.js";
import type * as buzz_pulse from "../buzz/pulse.js";
import type * as buzz_readState from "../buzz/readState.js";
import type * as buzz_relay from "../buzz/relay.js";
import type * as buzz_reminders from "../buzz/reminders.js";
import type * as buzz_search from "../buzz/search.js";
import type * as buzz_workflows from "../buzz/workflows.js";
import type * as calibration from "../calibration.js";
import type * as capabilities from "../capabilities.js";
import type * as channels from "../channels.js";
import type * as chat from "../chat.js";
import type * as checklistTemplates from "../checklistTemplates.js";
import type * as clips from "../clips.js";
import type * as contextPackets from "../contextPackets.js";
import type * as crons from "../crons.js";
import type * as customFields from "../customFields.js";
import type * as dataExport from "../dataExport.js";
import type * as dataStream from "../dataStream.js";
import type * as decisions from "../decisions.js";
import type * as docs from "../docs.js";
import type * as events from "../events.js";
import type * as executionDispatch from "../executionDispatch.js";
import type * as executionLifecycle from "../executionLifecycle.js";
import type * as executionPlans from "../executionPlans.js";
import type * as executionPolicy from "../executionPolicy.js";
import type * as favorites from "../favorites.js";
import type * as fieldLibrary from "../fieldLibrary.js";
import type * as forms from "../forms.js";
import type * as goals from "../goals.js";
import type * as health from "../health.js";
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
import type * as migrations from "../migrations.js";
import type * as milestones from "../milestones.js";
import type * as myWork from "../myWork.js";
import type * as network from "../network.js";
import type * as notificationCenter from "../notificationCenter.js";
import type * as notificationPrefs from "../notificationPrefs.js";
import type * as notifications from "../notifications.js";
import type * as oauth from "../oauth.js";
import type * as onboarding from "../onboarding.js";
import type * as opsOverview from "../opsOverview.js";
import type * as outcomeAssurance from "../outcomeAssurance.js";
import type * as pages from "../pages.js";
import type * as panelIntent from "../panelIntent.js";
import type * as plans from "../plans.js";
import type * as portfolio from "../portfolio.js";
import type * as presence from "../presence.js";
import type * as projects from "../projects.js";
import type * as projectsDirectory from "../projectsDirectory.js";
import type * as realtime from "../realtime.js";
import type * as realtimeAuth from "../realtimeAuth.js";
import type * as reports from "../reports.js";
import type * as revisions from "../revisions.js";
import type * as roadmaps from "../roadmaps.js";
import type * as rollups from "../rollups.js";
import type * as savedViews from "../savedViews.js";
import type * as scheduledTasks from "../scheduledTasks.js";
import type * as screens from "../screens.js";
import type * as scrumBoard from "../scrumBoard.js";
import type * as search from "../search.js";
import type * as sidebar from "../sidebar.js";
import type * as situations from "../situations.js";
import type * as skills from "../skills.js";
import type * as spaces from "../spaces.js";
import type * as spacesDirectory from "../spacesDirectory.js";
import type * as sprintPlanning from "../sprintPlanning.js";
import type * as sprintTemplates from "../sprintTemplates.js";
import type * as sprints from "../sprints.js";
import type * as taskBlueprints from "../taskBlueprints.js";
import type * as taskFieldValues from "../taskFieldValues.js";
import type * as tasks from "../tasks.js";
import type * as team from "../team.js";
import type * as templateCatalog from "../templateCatalog.js";
import type * as templates from "../templates.js";
import type * as timeEntries from "../timeEntries.js";
import type * as uiComponents from "../uiComponents.js";
import type * as userSettings from "../userSettings.js";
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
  _customFields: typeof _customFields;
  _docText: typeof _docText;
  _docToMarkdown: typeof _docToMarkdown;
  _idempotency: typeof _idempotency;
  _markdown: typeof _markdown;
  _refs: typeof _refs;
  _scope: typeof _scope;
  _situations: typeof _situations;
  _webhookNetwork: typeof _webhookNetwork;
  _x402: typeof _x402;
  admin: typeof admin;
  agentAi: typeof agentAi;
  agentApi: typeof agentApi;
  agentAuth: typeof agentAuth;
  agentKeys: typeof agentKeys;
  agentPingDeliveries: typeof agentPingDeliveries;
  agentPingDeliveryAction: typeof agentPingDeliveryAction;
  agentTemplates: typeof agentTemplates;
  agents: typeof agents;
  ai: typeof ai;
  aiDb: typeof aiDb;
  appearance: typeof appearance;
  attachments: typeof attachments;
  "buzz/_kinds": typeof buzz__kinds;
  "buzz/_nostr": typeof buzz__nostr;
  "buzz/_tables": typeof buzz__tables;
  "buzz/agentChat": typeof buzz_agentChat;
  "buzz/agents": typeof buzz_agents;
  "buzz/bridge": typeof buzz_bridge;
  "buzz/canvas": typeof buzz_canvas;
  "buzz/channels": typeof buzz_channels;
  "buzz/forum": typeof buzz_forum;
  "buzz/huddle": typeof buzz_huddle;
  "buzz/identity": typeof buzz_identity;
  "buzz/keys": typeof buzz_keys;
  "buzz/log": typeof buzz_log;
  "buzz/media": typeof buzz_media;
  "buzz/messages": typeof buzz_messages;
  "buzz/moderation": typeof buzz_moderation;
  "buzz/notifications": typeof buzz_notifications;
  "buzz/presence": typeof buzz_presence;
  "buzz/projects": typeof buzz_projects;
  "buzz/pulse": typeof buzz_pulse;
  "buzz/readState": typeof buzz_readState;
  "buzz/relay": typeof buzz_relay;
  "buzz/reminders": typeof buzz_reminders;
  "buzz/search": typeof buzz_search;
  "buzz/workflows": typeof buzz_workflows;
  calibration: typeof calibration;
  capabilities: typeof capabilities;
  channels: typeof channels;
  chat: typeof chat;
  checklistTemplates: typeof checklistTemplates;
  clips: typeof clips;
  contextPackets: typeof contextPackets;
  crons: typeof crons;
  customFields: typeof customFields;
  dataExport: typeof dataExport;
  dataStream: typeof dataStream;
  decisions: typeof decisions;
  docs: typeof docs;
  events: typeof events;
  executionDispatch: typeof executionDispatch;
  executionLifecycle: typeof executionLifecycle;
  executionPlans: typeof executionPlans;
  executionPolicy: typeof executionPolicy;
  favorites: typeof favorites;
  fieldLibrary: typeof fieldLibrary;
  forms: typeof forms;
  goals: typeof goals;
  health: typeof health;
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
  migrations: typeof migrations;
  milestones: typeof milestones;
  myWork: typeof myWork;
  network: typeof network;
  notificationCenter: typeof notificationCenter;
  notificationPrefs: typeof notificationPrefs;
  notifications: typeof notifications;
  oauth: typeof oauth;
  onboarding: typeof onboarding;
  opsOverview: typeof opsOverview;
  outcomeAssurance: typeof outcomeAssurance;
  pages: typeof pages;
  panelIntent: typeof panelIntent;
  plans: typeof plans;
  portfolio: typeof portfolio;
  presence: typeof presence;
  projects: typeof projects;
  projectsDirectory: typeof projectsDirectory;
  realtime: typeof realtime;
  realtimeAuth: typeof realtimeAuth;
  reports: typeof reports;
  revisions: typeof revisions;
  roadmaps: typeof roadmaps;
  rollups: typeof rollups;
  savedViews: typeof savedViews;
  scheduledTasks: typeof scheduledTasks;
  screens: typeof screens;
  scrumBoard: typeof scrumBoard;
  search: typeof search;
  sidebar: typeof sidebar;
  situations: typeof situations;
  skills: typeof skills;
  spaces: typeof spaces;
  spacesDirectory: typeof spacesDirectory;
  sprintPlanning: typeof sprintPlanning;
  sprintTemplates: typeof sprintTemplates;
  sprints: typeof sprints;
  taskBlueprints: typeof taskBlueprints;
  taskFieldValues: typeof taskFieldValues;
  tasks: typeof tasks;
  team: typeof team;
  templateCatalog: typeof templateCatalog;
  templates: typeof templates;
  timeEntries: typeof timeEntries;
  uiComponents: typeof uiComponents;
  userSettings: typeof userSettings;
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
