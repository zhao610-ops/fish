import type { ResolvedTrendPublishConfig } from "@src/utils/config/define-config.ts";
import type { ArtifactStore } from "@src/core/ports/artifact-store.ts";
import type { RunStateStore } from "@src/core/ports/run-state-store.ts";
import { WeixinPublisher } from "@src/integrations/publish/providers/weixin-publisher.ts";
import { WeixinRelayPublisher } from "@src/integrations/publish/providers/weixin-relay-publisher.ts";
import { reconcilePublications } from "./reconcile-publications.ts";

export async function monitorPublications(
  config: ResolvedTrendPublishConfig,
  stores: { artifactStore: ArtifactStore; runStateStore: RunStateStore },
  onError: (error: unknown) => void,
): Promise<void> {
  await reconcilePublications({
    ...stores,
    onError,
    publisher: (result) =>
      result.provider === "weixin-relay"
        ? new WeixinRelayPublisher(
          config.providers.publish.weixinRelay,
          config.providers.publish.weixin,
          result.accountId,
        )
        : new WeixinPublisher(
          config.providers.publish.weixin,
          result.accountId,
        ),
  });
}
