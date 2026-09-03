import type { ScrapedContent } from "@src/core/ports/content-scraper.ts";

/** 不将报名、目录、视频或壁纸下载页面当作完整文章。 */
export function nonArticleReason(
  candidate: ScrapedContent,
): string | undefined {
  let url: URL;
  try {
    url = new URL(candidate.url);
  } catch {
    return "候选链接无效";
  }
  if (
    /\/(?:training|courses|events|webinars|videos|tag|tags|category|author)(?:\/|$)/i
      .test(url.pathname)
  ) {
    return "课程、活动、视频或目录页面，不属于全文文章";
  }
  if (
    /\b(?:live online courses|course agenda|wallpapers edition)\b/i.test(
      candidate.title,
    )
  ) {
    return "课程日程或壁纸合集，不属于本轮文章类型";
  }
  return undefined;
}

/** 按站点轮询，避免第一个订阅源占满全文抓取预算；不改动传入数组。 */
export function balanceArticleCandidates(
  contents: ScrapedContent[],
): ScrapedContent[] {
  const groups = new Map<string, ScrapedContent[]>();
  for (const candidate of contents) {
    let host: string;
    try {
      host = new URL(candidate.url).hostname.replace(/^www\./, "");
    } catch {
      host = "invalid";
    }
    const group = groups.get(host) ?? [];
    group.push(candidate);
    groups.set(host, group);
  }
  const queues = [...groups.values()];
  const result: ScrapedContent[] = [];
  for (let index = 0; result.length < contents.length; index++) {
    for (const queue of queues) {
      if (queue[index]) result.push(queue[index]);
    }
  }
  return result;
}
