import {
  ContentImageUploader,
  ContentPublisher,
  PublishArticleRequest,
  PublishResult,
} from "@src/core/ports/content-publisher.ts";
import type { ResolvedTrendPublishConfig } from "@src/utils/config/define-config.ts";
import {
  type ResolvedWeixinPublishAccountConfig,
  resolveWeixinPublishAccount,
} from "@src/utils/config/define-config.ts";
import { SafeImageDownloader } from "@src/utils/image/safe-image-downloader.ts";
import { ProviderError } from "@src/core/errors/provider-error.ts";
import { redactError } from "@src/utils/security/redact.ts";
import {
  WeixinAccessTokenResponse,
  WeixinApiClient,
} from "@src/integrations/publish/providers/weixin-api-client.ts";
import { Logger } from "@zilla/logger";
const logger = new Logger("weixin-publisher");

interface WeixinToken {
  access_token: string;
  expires_in: number;
  expiresAt: Date;
}

interface WeixinDraft {
  media_id: string;
  article_id?: string;
}

interface WeixinMaterialImageResponse {
  media_id: string;
}

interface WeixinContentImageResponse {
  url: string;
}

function toArrayBuffer(imageBuffer: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (imageBuffer instanceof ArrayBuffer) {
    return imageBuffer;
  }

  const buffer = new ArrayBuffer(imageBuffer.byteLength);
  new Uint8Array(buffer).set(imageBuffer);
  return buffer;
}

export class WeixinPublisher implements ContentPublisher, ContentImageUploader {
  private static readonly COVER_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
  private static readonly CONTENT_IMAGE_MAX_BYTES = 1024 * 1024;
  private accessToken: WeixinToken | null = null;
  private appId: string | undefined;
  private appSecret: string | undefined;

  constructor(
    private readonly configuredProvider?: ResolvedTrendPublishConfig[
      "providers"
    ]["publish"]["weixin"],
    private readonly accountId?: string,
    private readonly apiClient = new WeixinApiClient(),
    private readonly imageDownloader = new SafeImageDownloader(),
  ) {}

  async refresh(): Promise<void> {
    const provider = this.getProvider();
    this.appId = provider.appId;
    this.appSecret = provider.appSecret;
    logger.debug("微信公众号配置:", {
      appId: maskSecret(this.appId),
      appSecret: maskSecret(this.appSecret),
    });
  }

  private async ensureAccessToken(): Promise<string> {
    // 检查现有token是否有效
    if (
      this.accessToken &&
      this.accessToken.expiresAt > new Date(Date.now() + 60000) // 预留1分钟余量
    ) {
      return this.accessToken.access_token;
    }

    try {
      await this.refresh();
      const response: WeixinAccessTokenResponse = await this.apiClient
        .getAccessToken(
          this.appId ?? "",
          this.appSecret ?? "",
        );
      const { access_token, expires_in } = response;

      if (!access_token) {
        throw new Error(
          "获取access_token失败: " + JSON.stringify(response),
        );
      }

      this.accessToken = {
        access_token,
        expires_in,
        expiresAt: new Date(Date.now() + expires_in * 1000),
      };

      return access_token;
    } catch (error) {
      logger.error("获取微信access_token失败:", redactError(error));
      throw error;
    }
  }

  private async uploadDraft(
    article: string,
    title: string,
    digest: string,
    mediaId: string,
  ): Promise<WeixinDraft> {
    const token = await this.ensureAccessToken();

    const provider = this.getProvider();
    const articles = [
      {
        title: title,
        author: provider.author,
        digest: digest,
        content: article,
        thumb_media_id: mediaId,
        need_open_comment: provider.needOpenComment ? 1 : 0,
        only_fans_can_comment: provider.onlyFansCanComment ? 1 : 0,
      },
    ];
    try {
      const response = await this.apiClient.postJson<WeixinDraft>(
        "/cgi-bin/draft/add",
        token,
        {
          articles,
        },
      );

      return {
        media_id: response.media_id,
      };
    } catch (error) {
      logger.error("上传微信草稿失败:", redactError(error));
      throw error;
    }
  }
  /**
   * 上传图片到微信
   * @param imageUrl 图片URL
   * @returns 图片ID
   */
  async uploadImage(imageUrl: string): Promise<string> {
    if (!imageUrl) {
      // 如果图片URL为空，则返回一个默认的图片ID
      return "SwCSRjrdGJNaWioRQUHzgF68BHFkSlb_f5xlTquvsOSA6Yy0ZRjFo0aW9eS3JJu_";
    }
    const image = await this.imageDownloader.download(imageUrl);
    if (image.bytes.byteLength > WeixinPublisher.COVER_IMAGE_MAX_BYTES) {
      throw new ProviderError({
        provider: "weixin",
        kind: "validation",
        message: "封面图片超过微信素材上传大小限制",
      });
    }

    const token = await this.ensureAccessToken();

    try {
      // 创建FormData并添加图片数据
      const formData = new FormData();
      formData.append(
        "media",
        new Blob([toArrayBuffer(image.bytes)], { type: image.contentType }),
        createImageFilename(image.contentType),
      );

      const response = await this.apiClient.postForm<
        WeixinMaterialImageResponse
      >(
        "/cgi-bin/material/add_material",
        token,
        formData,
        {
          type: "image",
        },
      );

      return response.media_id;
    } catch (error) {
      logger.error("上传微信图片失败:", redactError(error));
      throw error;
    }
  }

  /**
   * 上传图文消息内的图片获取URL
   * @param imageUrl 图片URL
   * @returns 图片URL
   * @description 本接口所上传的图片不占用公众号的素材库中图片数量的限制
   * 图片仅支持jpg/png格式，大小必须在1MB以下
   */
  async uploadContentImage(
    imageUrl: string,
    imageBuffer?: ArrayBuffer | Uint8Array,
  ): Promise<string> {
    if (!imageUrl) {
      throw new Error("图片URL不能为空");
    }

    const token = await this.ensureAccessToken();

    try {
      // 创建FormData并添加图片数据
      const formData = new FormData();

      if (imageBuffer) {
        // 如果提供了压缩后的图片buffer，直接使用
        const bytes = imageBuffer instanceof Uint8Array
          ? imageBuffer
          : new Uint8Array(imageBuffer);
        if (bytes.byteLength > WeixinPublisher.CONTENT_IMAGE_MAX_BYTES) {
          throw new ProviderError({
            provider: "weixin",
            kind: "validation",
            message: "正文图片超过微信图文图片上传大小限制",
          });
        }
        formData.append(
          "media",
          new Blob([toArrayBuffer(bytes)], { type: "image/jpeg" }),
          `image_${Math.random().toString(36).substring(2, 8)}.jpg`,
        );
      } else {
        // 否则下载原图
        const image = await new SafeImageDownloader({
          maxBytes: WeixinPublisher.CONTENT_IMAGE_MAX_BYTES,
        }).download(imageUrl);
        formData.append(
          "media",
          new Blob([toArrayBuffer(image.bytes)], { type: image.contentType }),
          createImageFilename(image.contentType),
        );
      }

      const response = await this.apiClient.postForm<
        WeixinContentImageResponse
      >(
        "/cgi-bin/media/uploadimg",
        token,
        formData,
      );

      return response.url;
    } catch (error) {
      logger.error("上传微信图文消息图片失败:", redactError(error));
      throw error;
    }
  }

  /**
   * 发布文章到微信
   * @param article 文章内容
   * @param title 文章标题
   * @param digest 文章摘要
   * @param mediaId 图片ID
   * @returns 发布结果
   */
  async publishArticle(request: PublishArticleRequest): Promise<PublishResult> {
    try {
      const account = this.getAccount();
      if (
        request.mode && request.mode !== "draft" && request.mode !== "publish"
      ) {
        throw new Error("不支持的微信发送模式");
      }
      // 上传草稿
      const draft = await this.uploadDraft(
        request.content,
        request.title,
        request.digest,
        request.coverMediaId,
      );
      if (!draft.media_id) throw new Error("微信未返回草稿 ID");
      if (request.mode === "publish") {
        const response = await this.apiClient.postJson<
          { publish_id: string | number }
        >(
          "/cgi-bin/freepublish/submit",
          await this.ensureAccessToken(),
          { media_id: draft.media_id },
        );
        if (!response.publish_id) {
          throw new Error("微信未返回发表任务 ID，需核对平台发表记录");
        }
        return {
          publishId: String(response.publish_id),
          draftMediaId: draft.media_id,
          status: "pending",
          publishedAt: new Date(),
          platform: "weixin",
          accountId: account.accountId,
          mode: "publish",
          provider: "weixin",
          reason: "微信发表任务已受理，等待审核结果",
        };
      }
      return {
        publishId: draft.media_id,
        status: "draft",
        publishedAt: new Date(),
        platform: "weixin",
        accountId: account.accountId,
        mode: "draft",
        provider: "weixin",
      };
    } catch (error) {
      logger.error("微信发布失败:", redactError(error));
      throw error;
    }
  }

  async getPublishStatus(result: PublishResult): Promise<PublishResult> {
    if (result.mode !== "publish" || result.status !== "pending") return result;
    const response = await this.apiClient.postJson<{
      publish_status: number;
      article_id?: string;
      article_detail?: { item?: { article_url: string }[] };
      fail_idx?: number[];
    }>(
      "/cgi-bin/freepublish/get",
      await this.ensureAccessToken(),
      { publish_id: result.publishId },
    );
    if (response.publish_status === 0) {
      const url = response.article_detail?.item?.[0]?.article_url;
      if (!url) {
        throw new Error("微信报告发表成功，但未返回文章链接，将继续查询");
      }
      return {
        ...result,
        status: "published",
        articleId: response.article_id,
        url,
        reason: "文章已公开发表",
      };
    }
    if (response.publish_status === 1) return result;
    const reasons: Record<number, string> = {
      2: "原创校验失败",
      3: "发表失败",
      4: "微信平台审核不通过",
      5: "文章已删除",
      6: "文章被平台封禁",
    };
    const reason = reasons[response.publish_status];
    if (!reason) {
      throw new Error(`未知的微信发表状态：${response.publish_status}`);
    }
    return { ...result, status: "failed", reason };
  }

  /**
   * 验证当前服务器IP是否在微信公众号的IP白名单中
   * @returns 返回验证结果，true表示IP在白名单中，false表示不在
   * @throws 当API调用失败时抛出错误（非IP白名单相关的错误）
   */
  async validateIpWhitelist(): Promise<string | boolean> {
    try {
      await this.ensureAccessToken();
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes("40164")) {
        return error.message.match(/invalid ip ([^ ]+)/)?.[1] ?? "未知IP";
      }
      throw error;
    }
  }

  private getAccount(): {
    accountId: string;
    provider: ResolvedWeixinPublishAccountConfig;
  } {
    if (!this.configuredProvider) {
      throw new Error("providers.publish.weixin is not configured");
    }
    const account = resolveWeixinPublishAccount(
      this.configuredProvider,
      this.accountId,
    );
    if (!account) {
      const requested = this.accountId?.trim();
      throw new Error(
        requested
          ? `未找到或未配置微信公众号账号: ${requested}`
          : "未配置默认微信公众号账号；多公众号配置时请设置 publisher.accountId",
      );
    }
    return { accountId: account.accountId, provider: account.account };
  }

  private getProvider(): ResolvedWeixinPublishAccountConfig {
    return this.getAccount().provider;
  }
}

function maskSecret(value: string | undefined): string {
  if (!value) return "";
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function createImageFilename(contentType: string): string {
  const extension = contentType === "image/png"
    ? "png"
    : contentType === "image/webp"
    ? "webp"
    : contentType === "image/gif"
    ? "gif"
    : "jpg";
  return `image_${crypto.randomUUID().slice(0, 8)}.${extension}`;
}
