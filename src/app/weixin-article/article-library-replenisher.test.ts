import { assertEquals } from "@std/assert";
import { ArticleLibraryReplenisher } from "./article-library-replenisher.ts";

Deno.test("自动补库有目标和每小时预算，重复扫描不重复生成", async () => {
  const slots = new Set<string>();
  let prepared = 0;
  const runner = new ArticleLibraryReplenisher(
    async () => [{ profileId: "p", targetSize: 5, readyCount: 0 }],
    async (slot) => {
      if (slots.has(slot)) return false;
      slots.add(slot);
      return true;
    },
    async () => {
      prepared++;
      return true;
    },
    () => {},
  );
  const now = new Date();
  await runner.tick(now);
  await runner.tick(now);
  assertEquals(prepared, 3);
});

Deno.test("库存已满不生成，空结果当轮停止，重入不产生第二批任务", async () => {
  let prepared = 0;
  const runner = new ArticleLibraryReplenisher(
    async () => [{ profileId: "full", targetSize: 3, readyCount: 3 }, {
      profileId: "empty",
      targetSize: 3,
      readyCount: 0,
    }],
    async () => true,
    async () => {
      prepared++;
      return false;
    },
    () => {},
  );
  await Promise.all([runner.tick(), runner.tick()]);
  assertEquals(prepared, 1);
});
