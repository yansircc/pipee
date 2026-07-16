import { lazy } from "react"

// This is the single browser-bundler edge for optional UI and rendering code.
// Callers depend on typed modules; only this adapter knows that Vite loads them
// as separate chunks.
export const FileViewer = lazy(() =>
  import("@/components/FileViewer").then((module) => ({
    default: module.FileViewer,
  })),
)

export const ModelsConfig = lazy(() =>
  import("@/components/ModelsConfig").then((module) => ({
    default: module.ModelsConfig,
  })),
)

export const SkillsConfig = lazy(() =>
  import("@/components/SkillsConfig").then((module) => ({
    default: module.SkillsConfig,
  })),
)

export const PluginsConfig = lazy(() =>
  import("@/components/PluginsConfig").then((module) => ({
    default: module.PluginsConfig,
  })),
)

export const loadMermaid = () => import("mermaid").then((module) => module.default)
