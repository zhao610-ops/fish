import { assertEquals, assertRejects } from "@std/assert";
import { LocalArtifactStore } from "./local-artifact-store.ts";

Deno.test("本地文件占位跨实例并发仅成功一次，重建实例仍保留记录", async () => {
  const dir = await Deno.makeTempDir({ prefix: "translation-claim-test-" });
  try {
    const stores = Array.from(
      { length: 12 },
      () => new LocalArtifactStore(dir),
    );
    const result = await Promise.all(
      stores.map((store, index) =>
        store.claimJson("translation-claims/article.json", {
          index,
          note: "测试占位",
        })
      ),
    );
    assertEquals(result.filter(Boolean).length, 1);
    assertEquals(
      await new LocalArtifactStore(dir).claimJson(
        "translation-claims/article.json",
        {},
      ),
      false,
    );
    const value = await stores[0].getObject("translation-claims/article.json");
    assertEquals(
      JSON.parse(new TextDecoder().decode(value!.body)).note,
      "测试占位",
    );
    await assertRejects(() => stores[0].claimJson("../outside.json", {}));
  } finally {
    // 只删除本测试创建的临时目录。
    await Deno.remove(dir, { recursive: true });
  }
});
