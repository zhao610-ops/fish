import { assertEquals } from "@std/assert";
import { resolveArticleDryRun } from "./article-run-mode.ts";
import { evaluateArticleQualityGate } from "./quality-gate.service.ts";
import { resolveTrendPublishConfig } from "@src/utils/config/define-config.ts";
import type { ArticleQualityReview } from "../domain/quality-review.ts";

Deno.test("定时显式关闭预览可以覆盖方案默认值，不需要强制绕过审稿", () => {
  const dryRun = resolveArticleDryRun(
    { dryRun: false, forcePublish: false },
    true,
  );
  assertEquals(dryRun, false);
  const config = resolveTrendPublishConfig({}).features.article.qualityGate;
  const review = {
    issues: [{ severity: "blocker", message: "事实未确认" }],
    allowPublish: false,
    overallScore: 20,
  } as ArticleQualityReview;
  assertEquals(
    evaluateArticleQualityGate({ review, config, dryRun, forcePublish: false })
      .allowed,
    false,
  );
});

Deno.test("显式预览不会被遗留强制参数覆盖，未指定时使用方案默认值", () => {
  assertEquals(
    resolveArticleDryRun({ dryRun: true, forcePublish: true }, false),
    true,
  );
  assertEquals(resolveArticleDryRun({}, true), true);
  assertEquals(resolveArticleDryRun({}, false), false);
});
