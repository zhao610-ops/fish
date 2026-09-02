import {
  createWeixinArticleDependencies,
  CreateWeixinArticleDependenciesOptions,
} from "@src/app/weixin-article/create-weixin-article-dependencies.ts";
import type { ResolvedTrendPublishConfig } from "@src/utils/config/define-config.ts";
import { createLocalArticleRuntimeStores } from "./local-runtime-stores.ts";

export async function createLocalWeixinArticleDependencies(
  config: ResolvedTrendPublishConfig,
  options:
    & Omit<
      CreateWeixinArticleDependenciesOptions,
      "artifactStore" | "runStateStore" | "mode"
    >
    & { outputDir?: string } = {},
) {
  const stores = createLocalArticleRuntimeStores(config, options);
  return await createWeixinArticleDependencies(config, {
    ...options,
    artifactStore: stores.artifactStore,
    runStateStore: stores.runStateStore,
    editorialMemoryStore: options.editorialMemoryStore ??
      stores.editorialMemoryStore,
    mode: "local",
    vectorStoreFactory: options.vectorStoreFactory ?? (async () => {
      const { SQLiteVectorStore } = await import(
        "@src/integrations/vector/sqlite-vector-store.ts"
      );
      return new SQLiteVectorStore(config.storage.vector.sqlitePath);
    }),
  });
}
