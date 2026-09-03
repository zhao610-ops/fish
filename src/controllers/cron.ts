import cron from "npm:node-cron@3.0.3";
import { Logger } from "@zilla/logger";
import { LocalWorkflowRuntime } from "@src/core/workflow/local-workflow-runtime.ts";
import {
  createLocalWeixinArticleWorkflowDefinition,
} from "@src/app/weixin-article/local-workflow.definition.ts";
import { getAppConfig } from "@src/utils/config/app-config.ts";
import { createArticleNotifier } from "@src/app/weixin-article/notifications.ts";
import { createLocalArticleRuntimeStores } from "@src/app/weixin-article/local-runtime-stores.ts";
import { seedArticleRuntimeConfig } from "@src/app/weixin-article/runtime/article-runtime-config.service.ts";
import { ArticleScheduleRunner } from "@src/app/weixin-article/article-schedule-runner.ts";
import { monitorPublications } from "@src/app/weixin-article/publication-monitor.ts";
import { ArticleLibraryReplenisher } from "@src/app/weixin-article/article-library-replenisher.ts";
import { resolveArticleRuntimeConfig } from "@src/app/weixin-article/runtime/article-runtime-config.service.ts";
import { createLocalWeixinArticleDependencies } from "@src/app/weixin-article/create-local-weixin-article-dependencies.ts";
import { translationKey } from "@src/features/weixin-article/domain/translation-policy.ts";
const logger = new Logger("cron");
export enum WorkflowType {
  WeixinArticle = "weixin-article-workflow",
}

export function getWorkflow(type: WorkflowType) {
  if (type !== WorkflowType.WeixinArticle) {
    throw new Error(`未知的工作流类型: ${type}`);
  }
  return createLocalWeixinArticleWorkflowDefinition();
}

export const startCronJobs = async () => {
  const config = await getAppConfig();
  const notifier = createArticleNotifier(config);
  const stores = createLocalArticleRuntimeStores(config);
  await seedArticleRuntimeConfig(stores.runtimeConfigStore, config);
  const report = (error: unknown) => {
    logger.error("自动任务失败:", error);
    void notifier.notify("自动任务失败", String(error)).catch((error) =>
      logger.error("通知失败:", error)
    );
  };
  const runner = new ArticleScheduleRunner(
    stores.runtimeConfigStore,
    async (due, runId) => {
      await stores.runStateStore.startRun({
        runId,
        profileId: due.schedule.profileId,
        mode: "local",
        dryRun: due.schedule.dryRun,
        trigger: "cron",
      });
      try {
        await new LocalWorkflowRuntime().run(
          createLocalWeixinArticleWorkflowDefinition(),
          {
            payload: {
              runId,
              trigger: "cron",
              dryRun: due.schedule.dryRun,
              profileId: due.schedule.profileId,
            },
            id: runId,
            timestamp: Date.now(),
          },
        );
      } catch (error) {
        await stores.runStateStore.failRun(
          runId,
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
    },
    report,
  );
  let checkingPublications = false;
  const replenisher = new ArticleLibraryReplenisher(
    async () => {
      const plans = [];
      const active = (await stores.runStateStore.listRuns(100)).filter((run) =>
        run.status === "running" || run.status === "queued"
      );
      for (
        const profile of await stores.runtimeConfigStore.listFeatureProfiles(
          "article",
        )
      ) {
        const schedule = await stores.runtimeConfigStore.getSchedule(
          profile.id,
        );
        if (
          !profile.enabled || !schedule?.enabled || schedule.dryRun ||
          active.some((run) => run.profileId === profile.id)
        ) continue;
        const resolved = await resolveArticleRuntimeConfig(
          stores.runtimeConfigStore,
          config,
          profile.id,
        );
        if (
          resolved.config.features.article.publisher.mode !== "publish" ||
          resolved.config.features.article.translation.mode !== "translation"
        ) continue;
        const dependencies = await createLocalWeixinArticleDependencies(
          resolved.config,
          {
            profileId: profile.id,
            accountId: resolved.account?.id,
            accountBrand: resolved.account?.brand,
          },
        );
        const library = await dependencies.translationService!.library(
          profile.id,
        );
        plans.push({
          profileId: profile.id,
          targetSize:
            resolved.config.features.article.translation.libraryTargetSize,
          readyCount: (await library.list()).filter((entry) =>
            entry.state === "ready"
          ).length,
        });
      }
      return plans;
    },
    async (slot) =>
      await stores.artifactStore.claimJson(
        `library-replenishment/${await translationKey("slot", slot)}.json`,
        { slot, at: new Date().toISOString() },
      ),
    async (profileId, slot) => {
      const runId = `prepare-${await translationKey("slot", slot)}`;
      await new LocalWorkflowRuntime().run(
        createLocalWeixinArticleWorkflowDefinition(),
        {
          id: runId,
          timestamp: Date.now(),
          payload: {
            runId,
            profileId,
            articleAction: "prepare",
            dryRun: true,
            trigger: "cron",
          },
        },
      );
      return Boolean(
        await stores.artifactStore.getObject(
          stores.artifactStore.createRunKey(runId, "library-entry", "json"),
        ),
      );
    },
    report,
  );
  const checkPublications = async () => {
    if (checkingPublications) return;
    checkingPublications = true;
    try {
      await monitorPublications(
        config,
        stores,
        (error) => logger.error("发表结果查询失败，下轮重试:", error),
      );
    } finally {
      checkingPublications = false;
    }
  };
  logger.info("自动任务已启动，每分钟读取最新定时设置并检查发表结果");
  return cron.schedule("* * * * *", () => {
    void runner.tick().catch(report);
    void checkPublications().catch(report);
    void replenisher.tick().catch(report);
  }, { timezone: "Asia/Shanghai" });
};
