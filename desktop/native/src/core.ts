import { Cmd, Sub, asciiBytes, utf8Bytes } from "@native-sdk/core";

export interface Model {
  readonly page: number;
  readonly signedIn: boolean;
  readonly status: Uint8Array;
  readonly sidebarOpen: boolean;
}

export type Msg =
  | { readonly kind: "show_home" }
  | { readonly kind: "show_inbox" }
  | { readonly kind: "show_my_work" }
  | { readonly kind: "show_spaces" }
  | { readonly kind: "show_projects" }
  | { readonly kind: "show_pages" }
  | { readonly kind: "show_agents" }
  | { readonly kind: "show_appearance" }
  | { readonly kind: "toggle_sidebar" }
  | { readonly kind: "sign_in" }
  | { readonly kind: "open_cli_docs" }
  | { readonly kind: "refresh" };

export function initialModel(): Model {
  return {
    page: 4,
    signedIn: false,
    status: utf8Bytes("Sign in to sync your Operate workspace"),
    sidebarOpen: true,
  };
}

export function pageTitle(model: Model): Uint8Array {
  if (model.page === 0) return utf8Bytes("Home");
  if (model.page === 1) return utf8Bytes("Inbox");
  if (model.page === 2) return utf8Bytes("My work");
  if (model.page === 3) return utf8Bytes("Spaces");
  if (model.page === 4) return utf8Bytes("Projects");
  if (model.page === 5) return utf8Bytes("Pages");
  if (model.page === 6) return utf8Bytes("Agents");
  return utf8Bytes("Appearance");
}

export function pageSubtitle(model: Model): Uint8Array {
  if (model.page === 4) return utf8Bytes("6 projects");
  if (model.page === 1) return utf8Bytes("3 waiting");
  return utf8Bytes("Operate workspace");
}

export function isProjects(model: Model): boolean {
  return model.page === 4;
}

export function update(model: Model, msg: Msg): Model | [Model, Cmd<Msg>] {
  switch (msg.kind) {
    case "show_home": return { ...model, page: 0 };
    case "show_inbox": return { ...model, page: 1 };
    case "show_my_work": return { ...model, page: 2 };
    case "show_spaces": return { ...model, page: 3 };
    case "show_projects": return { ...model, page: 4 };
    case "show_pages": return { ...model, page: 5 };
    case "show_agents": return { ...model, page: 6 };
    case "show_appearance": return { ...model, page: 7 };
    case "toggle_sidebar": return { ...model, sidebarOpen: !model.sidebarOpen };
    case "sign_in":
      return [
        { ...model, status: utf8Bytes("Continue securely in your browser") },
        Cmd.openExternalUrl(asciiBytes("https://www.operate.to/sign-in?source=mac-app")),
      ];
    case "open_cli_docs":
      return [model, Cmd.openExternalUrl(asciiBytes("https://www.operate.to/resources/cli"))];
    case "refresh":
      return { ...model, status: utf8Bytes("Ready to sync after sign in") };
  }
}

export function subscriptions(_model: Model): Sub<Msg> {
  return Sub.none;
}
