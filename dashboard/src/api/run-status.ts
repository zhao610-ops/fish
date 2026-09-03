export function runStatusLabel(status?: string): string {
  const labels: Record<string, string> = {
    queued: "排队中",
    running: "运行中",
    publishing: "等待发表",
    succeeded: "已完成",
    skipped: "已跳过",
    failed: "失败",
    cancelled: "已取消",
    pending: "等待中",
  };
  return status ? labels[status] ?? status : "未运行";
}
