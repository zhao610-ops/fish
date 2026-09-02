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
  }, { timezone: "Asia/Shanghai" });
};
