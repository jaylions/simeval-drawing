import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import AudraMode from "./audra/AudraMode";
import "./style.css";

// The incomplete-shapes task is a separate mode, not a variant of the
// Excalidraw session app. Reachable as /?mode=audra-incomplete-shapes or
// /audra-incomplete-shapes; anything else keeps the existing app unchanged.
const audraModeName = "audra-incomplete-shapes";
const requestedMode =
  new URLSearchParams(window.location.search).get("mode") ??
  window.location.pathname.replace(/^\/+|\/+$/g, "");

createRoot(document.getElementById("root")!).render(
  <StrictMode>{requestedMode === audraModeName ? <AudraMode /> : <App />}</StrictMode>
);
