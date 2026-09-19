import {
  parseProject,
} from "@kinetra/project-model";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import "./style.css";

async function boot(): Promise<void> {
  const root = document.getElementById("root");
  if (!root) {
    throw new Error("Kinetra editor root element is missing");
  }

  if (!window.kinetraEditor) {
    throw new Error(
      "Kinetra editor preload bridge is unavailable",
    );
  }

  const loaded =
    await window.kinetraEditor.loadProjectText();
  const project = parseProject(loaded.text);

  createRoot(root).render(
    <StrictMode>
      <App
        project={project}
        projectPath={loaded.path}
        writable={loaded.writable}
      />
    </StrictMode>,
  );
}

void boot();
