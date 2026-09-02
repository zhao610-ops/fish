export interface ContentPublisher {
  // 上传图片到指定平台
  uploadImage(imageUrl: string): Promise<string>;

  // 发布文章到指定平台
  publishArticle(request: PublishArticleRequest): Promise<PublishResult>;

  // 查询已提交的发送结果，不重复提交文章。
  getPublishStatus?(result: PublishResult): Promise<PublishResult>;
}

export interface ContentImageUploader {
  uploadContentImage(
    imageUrl: string,
    imageBuffer?: ArrayBuffer | Uint8Array,
  ): Promise<string>;
}

export interface PublishArticleRequest {
  content: string;
  title: string;
  digest: string;
  coverMediaId: string;
  mode?: "draft" | "publish";
  /** 同一次运行保持不变，用于记录本次发表请求。 */
  requestId?: string;
}

export interface PublishResult {
  publishId: string;
  url?: string;
  status: PublishStatus;
  publishedAt: Date;
  platform: string;
  accountId?: string;
  reason?: string;
  mode?: "draft" | "publish";
  draftMediaId?: string;
  articleId?: string;
  provider?: "weixin" | "weixin-relay";
}

export type PublishStatus =
  | "pending"
  | "published"
  | "failed"
  | "draft"
  | "scheduled"
  | "blocked";
