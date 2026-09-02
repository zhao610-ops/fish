import { LocalArtifactStore } from "@src/platform/local/local-artifact-store.ts";
import { SQLiteRunStateStore } from "@src/platform/local/sqlite-run-state-store.ts";
import { SQLiteRuntimeConfigStore } from "@src/platform/local/sqlite-runtime-config-store.ts";
import { SQLiteEditorialMemoryStore } from "@src/platform/local/sqlite-editorial-memory-store.ts";
import type { ResolvedTrendPublishConfig } from "@src/utils/config/define-config.ts";
import { join } from "node:path";

const databaseStores = new Map<string, {
  runtimeConfigStore: SQLiteRuntimeConfigStore;
  editorialMemoryStore: SQLiteEditorialMemoryStore;
}>();

export function createLocalArticleRuntimeStores(
  config: ResolvedTrendPublishConfig,
  options: { outputDir?: string } = {},
) {
  const outputDir = options.outputDir ||
    config.storage.artifacts.outputDir ||
    config.storage.runState.outputDir ||
    "src/temp";
  const baseDir = join(Deno.cwd(), outputDir);
  const databasePath = config.storage.runtimeConfig.sqlitePath;
  let shared = databaseStores.get(databasePath);
  if (!shared) {
    shared = {
      runtimeConfigStore: new SQLiteRuntimeConfigStore(databasePath),
      editorialMemoryStore: new SQLiteEditorialMemoryStore(databasePath),
    };
    databaseStores.set(databasePath, shared);
  }
  return {
    ...shared,
    artifactStore: new LocalArtifactStore(baseDir),
    runStateStore: new SQLiteRunStateStore(baseDir),
  };
}
