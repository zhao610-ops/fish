import type {
  ArtifactRef,
  ArtifactStore,
} from "@src/core/ports/artifact-store.ts";
import { decodeJsonArtifact } from "@src/core/ports/artifact-store.ts";
import type { PublishResult } from "@src/core/ports/content-publisher.ts";
import {
  canonicalArticleUrl,
  translationKey,
} from "../domain/translation-policy.ts";
import type { TranslatedArticle } from "./translation.service.ts";

export interface LibraryArticle {
  id: string;
  profileId: string;
  scope: string;
  policyKey: string;
  preparedRunId: string;
  createdAt: string;
  expiresAt: string;
  article: TranslatedArticle;
  htmlRef: ArtifactRef;
}

export interface LibraryArticleView extends LibraryArticle {
  state:
    | "ready"
    | "expired"
    | "policy-changed"
    | "reserved"
    | "published"
    | "draft"
    | "blocked"
    | "failed";
  publishRunId?: string;
  url?: string;
}

/** 不可变成稿与原子发送占位分离；超时或重启后不会自动释放未知发送结果。 */
export class ArticleLibraryService {
  constructor(
    private readonly store: ArtifactStore,
    readonly scope: string,
    readonly profileId: string,
    readonly policyKey: string,
    private readonly maxAgeHours: number,
  ) {}

  private async directory(): Promise<string> {
    return `article-library/${await translationKey(
      this.scope,
      this.profileId,
    )}`;
  }

  async list(now = new Date()): Promise<LibraryArticleView[]> {
    if (!this.store.listKeys) {
      throw new Error("当前存储不支持文章库，请使用本地或 Docker 持久化存储");
    }
    const result: LibraryArticleView[] = [];
    for (const key of await this.store.listKeys(await this.directory())) {
      const object = await this.store.getObject(key);
      if (!object) continue;
      let entry: LibraryArticle;
      try {
        entry = decodeJsonArtifact<LibraryArticle>(object.body);
      } catch {
        continue;
      }
      if (
        entry.scope !== this.scope || entry.profileId !== this.profileId ||
        !entry.article?.html || !/^[a-f0-9]{64}$/.test(entry.id) ||
        !Number.isFinite(Date.parse(entry.expiresAt))
      ) continue;
      let state: LibraryArticleView["state"] =
        entry.policyKey !== this.policyKey
          ? "policy-changed"
          : Date.parse(entry.expiresAt) <= now.getTime()
          ? "expired"
          : "ready";
      let publishRunId: string | undefined;
      let url: string | undefined;
      if (
        await this.store.getObject(
          `${await this.directory()}/blocked/${entry.id}.json`,
        )
      ) state = "blocked";
      const reservation = await this.store.getObject(
        `${await this.directory()}/reservations/${entry.id}.json`,
      );
      if (reservation) {
        state = "reserved";
        try {
          publishRunId =
            decodeJsonArtifact<{ runId: string }>(reservation.body).runId;
          const publication = await this.store.getObject(
            this.store.createRunKey(publishRunId, "14-publish-result", "json"),
          );
          if (publication) {
            const value = decodeJsonArtifact<PublishResult>(publication.body);
            if (
              value.status === "published" || value.status === "draft" ||
              value.status === "failed"
            ) state = value.status;
            url = value.status === "published" ? value.url : undefined;
          }
        } catch { /* 不完整占位保持待核对，不自动回队列。 */ }
      }
      result.push({ ...entry, state, publishRunId, url });
    }
    return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async add(
    article: TranslatedArticle,
    runId: string,
    now = new Date(),
  ): Promise<LibraryArticle> {
    if (!this.store.claimJson) throw new Error("文章库需要原子写入能力");
    const current = (await this.list(now)).find((entry) =>
      entry.state === "ready" &&
      canonicalArticleUrl(entry.article.sourceUrl) ===
        canonicalArticleUrl(article.sourceUrl)
    );
    if (current) return current;
    const id = await translationKey(
      this.policyKey,
      `${article.sourceHash}:${
        Math.floor(now.getTime() / (this.maxAgeHours * 3600000))
      }`,
    );
    const entry: LibraryArticle = {
      id,
      scope: this.scope,
      profileId: this.profileId,
      policyKey: this.policyKey,
      preparedRunId: runId,
      article,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.maxAgeHours * 3600000)
        .toISOString(),
      htmlRef: await this.store.putText(
        this.store.createRunKey(runId, "19-final-article", "html"),
        article.html,
        { label: "待发文章全文", contentType: "text/html; charset=utf-8" },
      ),
    };
    const key = `${await this.directory()}/${id}.json`;
    if (!await this.store.claimJson(key, entry)) {
      const existing = await this.store.getObject(key);
      if (!existing) throw new Error("文章入库占位异常");
      return decodeJsonArtifact<LibraryArticle>(existing.body);
    }
    return entry;
  }

  async reserve(entry: LibraryArticle, runId: string): Promise<boolean> {
    if (!this.store.claimJson) throw new Error("文章库需要原子写入能力");
    if (
      entry.scope !== this.scope || entry.profileId !== this.profileId ||
      entry.policyKey !== this.policyKey ||
      Date.parse(entry.expiresAt) <= Date.now()
    ) return false;
    if (
      !(await this.list()).some((item) =>
        item.id === entry.id && item.state === "ready"
      )
    ) return false;
    return await this.store.claimJson(
      `${await this.directory()}/reservations/${entry.id}.json`,
      { runId, at: new Date().toISOString() },
    );
  }

  async block(entry: LibraryArticle, reason: string): Promise<void> {
    await this.store.putJson(
      `${await this.directory()}/blocked/${entry.id}.json`,
      { reason, at: new Date().toISOString() },
    );
  }
}
