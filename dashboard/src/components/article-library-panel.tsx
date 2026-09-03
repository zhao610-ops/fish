import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiJson } from "../api/client.ts";
import type { ArtifactRef } from "../api/types.ts";
import { Badge, Button, Card } from "./ui.tsx";

interface LibraryItem {
  id: string;
  title: string;
  state: string;
  expiresAt: string;
  htmlRef: ArtifactRef;
  url?: string;
}

const labels: Record<string, string> = {
  ready: "待发",
  expired: "已过期",
  "policy-changed": "策略已变化",
  reserved: "已占用／结果待确认",
  published: "已发表",
  draft: "已创建草稿",
  failed: "发表失败",
  blocked: "复查不通过",
};

export function ArticleLibraryPanel(
  { apiKey, profileId, onPreview, onSelectRun }: {
    apiKey: string;
    profileId: string;
    onPreview: (ref: ArtifactRef) => void;
    onSelectRun: (id: string) => void;
  },
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<LibraryItem | null>(null);
  const library = useQuery({
    queryKey: ["article-library", profileId, apiKey],
    queryFn: () =>
      apiJson<{ articles: LibraryItem[]; targetSize: number }>(
        `/api/article-library?profileId=${encodeURIComponent(profileId)}`,
        apiKey,
      ),
    refetchInterval: 15000,
  });
  const run = async (entry?: LibraryItem) => {
    setBusy(true);
    setError("");
    setConfirm(null);
    const runId = `${
      entry ? "publish-library" : "prepare-library"
    }-${crypto.randomUUID()}`;
    try {
      await apiJson("/api/runs", apiKey, {
        method: "POST",
        body: JSON.stringify({
          runId,
          profileId,
          articleAction: entry ? "publish-next" : "prepare",
          libraryArticleId: entry?.id,
          dryRun: !entry,
          publishMode: entry ? "publish" : undefined,
        }),
      });
      onSelectRun(runId);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      await library.refetch();
    }
  };
  return (
    <Card className="xl:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">待发文章库</h2>
          <p className="tp-muted mt-1 text-xs">
            先备稿、审核后入库。正式运行优先取库存，过期或策略变化后不发送。库存目标
            {" "}
            {library.data?.targetSize ?? "-"} 篇。
          </p>
        </div>
        <Button disabled={busy} onClick={() => void run()}>
          {busy ? "任务执行中…" : "提前生成一篇（不发布）"}
        </Button>
      </div>
      {(error || library.error) && (
        <p role="alert" className="tp-danger mt-3">
          {error || String(library.error)}
        </p>
      )}
      {!library.data?.articles.length && (
        <p className="tp-muted mt-3 text-sm">
          暂无入库文章。预览记录不会自动当作待发库存。
        </p>
      )}
      <div className="mt-3 grid gap-2">
        {library.data?.articles.slice().reverse().slice(0, 20).map((entry) => (
          <div
            key={entry.id}
            className="flex flex-wrap items-center gap-2 rounded-md border p-3"
          >
            <Badge>{labels[entry.state] ?? entry.state}</Badge>
            <span className="min-w-0 flex-1 text-sm">{entry.title}</span>
            <span className="tp-muted text-xs">
              有效至 {new Date(entry.expiresAt).toLocaleString("zh-CN")}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onPreview(entry.htmlRef)}
            >
              预览全文
            </Button>
            {entry.state === "ready" && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => setConfirm(entry)}
              >
                正式发表此篇
              </Button>
            )}
            {entry.url && (
              <a
                href={entry.url}
                target="_blank"
                rel="noreferrer"
                className="text-sm underline"
              >
                查看公开文章
              </a>
            )}
          </div>
        ))}
      </div>
      {confirm && (
        <div className="mt-3 rounded-md border p-3">
          <p>
            确认将《{confirm
              .title}》公开发表到当前方案的公众号？这不是预览，不会开启每日定时。
          </p>
          <div className="mt-2 flex gap-2">
            <Button disabled={busy} onClick={() => void run(confirm)}>
              确认正式发表一篇
            </Button>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              取消
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
