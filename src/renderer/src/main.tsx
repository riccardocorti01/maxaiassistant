import "./lib/web-bridge";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { NotchApp } from "./NotchApp";
import { OverlayApp } from "./OverlayApp";
import { PermissionApp } from "./PermissionApp";
import { SettingsApp } from "./components/settings/settings-view";
import "./styles/globals.css";

const route = window.location.hash.replace(/^#\/?/, "");
const ROUTES = {
  settings: SettingsApp,
  overlay: OverlayApp,
  permission: PermissionApp,
  notch: NotchApp,
} as const;
const isRoute = (r: string): r is keyof typeof ROUTES => r in ROUTES;

document.documentElement.dataset.platform = window.opendex.platform;
document.documentElement.dataset.window = isRoute(route) ? route : "main";

const Root = isRoute(route) ? ROUTES[route] : App;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
