import { assertEquals } from "@std/assert";
import {
  ArticleScheduleRunner,
  scheduleRunId,
} from "./article-schedule-runner.ts";
import {
  createScheduleSlot,
  isCronDue,
} from "@src/core/storage/runtime-config-utils.ts";
import type { RuntimeSchedule } from "@src/core/ports/runtime-config-store.ts";

function fixture(profiles = ["a"]) {
  const schedules: RuntimeSchedule[] = profiles.map((id) => ({
    id,
    profileId: id,
    featureKey: "article",
    name: id,
    cron: "3 8 * * *",
    timezone: "Asia/Shanghai",
    dryRun: false,
    enabled: true,
    createdAt: "",
    updatedAt: "",
  }));
  const seen = new Set<string>();
  return {
    schedules,
    store: {
      listDueSchedules: async (now: Date) =>
        schedules.filter((schedule) =>
          schedule.enabled && isCronDue(schedule.cron, now, schedule.timezone)
        ).map((schedule) => ({
          schedule,
          slot: createScheduleSlot(schedule.id, now, schedule.timezone),
        })),
      markScheduleTriggered: async (_id: string, slot: string) => {
        if (seen.has(slot)) return false;
        seen.add(slot);
        return true;
      },
    },
  };
}

Deno.test("非五分钟整点可执行，同一分钟不重复，次日继续循环", async () => {
  const { store } = fixture();
  const ids: string[] = [];
  const runner = new ArticleScheduleRunner(store, async (_due, id) => {
    ids.push(id);
  }, (error) => {
    throw error;
  });
  await runner.tick(new Date("2026-09-02T00:03:00Z"));
  await runner.drain();
  await runner.tick(new Date("2026-09-02T00:03:30Z"));
  await runner.drain();
  await runner.tick(new Date("2026-09-03T00:03:00Z"));
  await runner.drain();
  assertEquals(ids.length, 2);
  assertEquals(ids[0] === ids[1], false);
  assertEquals(
    await scheduleRunId("same-slot"),
    await scheduleRunId("same-slot"),
  );
});

Deno.test("失败任务不会中断同批次后续任务", async () => {
  const { store } = fixture(["a", "b"]);
  const done: string[] = [];
  const errors: unknown[] = [];
  const runner = new ArticleScheduleRunner(store, async (due) => {
    if (due.schedule.profileId === "a") throw new Error("模拟失败");
    done.push(due.schedule.profileId);
  }, (error) => {
    errors.push(error);
  });
  await runner.tick(new Date("2026-09-02T00:03:00Z"));
  await runner.drain();
  assertEquals(done, ["b"]);
  assertEquals(errors.length, 1);
});

Deno.test("长任务不阻塞扫描，同方案未完成时不积压重复任务", async () => {
  const { store } = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let count = 0;
  const runner = new ArticleScheduleRunner(store, async () => {
    count++;
    await gate;
  }, () => {});
  await Promise.all([
    runner.tick(new Date("2026-09-02T00:03:00Z")),
    runner.tick(new Date("2026-09-02T00:03:00Z")),
  ]);
  await runner.tick(new Date("2026-09-03T00:03:00Z"));
  assertEquals(count, 1);
  release();
  await runner.drain();
});

Deno.test("修改时间和暂停规则在下一次扫描即时生效", async () => {
  const { store, schedules } = fixture();
  let count = 0;
  const runner = new ArticleScheduleRunner(store, async () => {
    count++;
  }, () => {});
  schedules[0].cron = "7 9 * * *";
  await runner.tick(new Date("2026-09-02T00:03:00Z"));
  await runner.drain();
  assertEquals(count, 0);
  await runner.tick(new Date("2026-09-02T01:07:00Z"));
  await runner.drain();
  assertEquals(count, 1);
  schedules[0].enabled = false;
  await runner.tick(new Date("2026-09-03T01:07:00Z"));
  await runner.drain();
  assertEquals(count, 1);
});
