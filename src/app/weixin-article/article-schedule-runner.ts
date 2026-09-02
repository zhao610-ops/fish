import type {
  RuntimeConfigStore,
  RuntimeScheduleTick,
} from "@src/core/ports/runtime-config-store.ts";

/** 扫描与执行分离：长文章不会阻塞下一分钟检查，单个任务失败不会中断队列。 */
export class ArticleScheduleRunner {
  private scanning = false;
  private readonly activeProfiles = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: Pick<
      RuntimeConfigStore,
      "listDueSchedules" | "markScheduleTriggered"
    >,
    private readonly execute: (
      due: RuntimeScheduleTick,
      runId: string,
    ) => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}

  async tick(now = new Date()): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      for (const due of await this.store.listDueSchedules(now)) {
        try {
          // 同一方案尚未完成时跳过本轮，避免循环间隔过短导致任务无限积压。
          if (this.activeProfiles.has(due.schedule.profileId)) continue;
          const runId = await scheduleRunId(due.slot);
          if (
            !await this.store.markScheduleTriggered(due.schedule.id, due.slot)
          ) continue;
          this.activeProfiles.add(due.schedule.profileId);
          this.queue = this.queue.then(async () => {
            try {
              await this.execute(due, runId);
            } catch (error) {
              this.report(error);
            } finally {
              this.activeProfiles.delete(due.schedule.profileId);
            }
          });
        } catch (error) {
          this.report(error);
        }
      }
    } finally {
      this.scanning = false;
    }
  }

  async drain(): Promise<void> {
    await this.queue;
  }

  private report(error: unknown): void {
    try {
      this.onError(error);
    } catch { /* 通知失败不影响后续调度。 */ }
  }
}

export async function scheduleRunId(slot: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(slot)),
  );
  return `cron-${
    Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("")
  }`;
}
