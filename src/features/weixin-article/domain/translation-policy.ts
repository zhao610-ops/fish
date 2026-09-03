export interface TranslationPolicy {
  /** 历史组稿模式只允许预览，不再允许绕过翻译安全流程发表。 */
  mode: "translation" | "editorial-preview";
  allowedTopics: string[];
  blockedTopics: string[];
  glossary: Record<string, string>;
  maxCandidates: number;
  maxSourceChars: number;
  chunkChars: number;
  minQualityScore: number;
  /** 必须是本账号已上传并检查过的自有封面，不使用原项目的默认素材。 */
  coverMediaId: string;
  /** 待发库存目标；0 关闭自动备稿。仅已启用的正式发表定时会自动补库。 */
  libraryTargetSize: number;
  libraryMaxAgeHours: number;
}

export const REQUIRED_BLOCKED_TOPICS = [
  "政治人物、政党、选举、政府政策、国际关系、制裁、地缘政治与领土争议",
  "战争、军事、武器、恐怖主义与极端主义",
  "宗教或族群冲突、仇恨歧视、色情、赌博、暴力及违法操作教程",
  "个人隐私泄露、医疗诊断、投资建议及重大社会争议事件",
];

export function resolveTranslationPolicy(
  input: Partial<TranslationPolicy> = {},
): TranslationPolicy {
  if (
    input.mode && !["translation", "editorial-preview"].includes(input.mode)
  ) {
    throw new Error("不支持的内容处理模式");
  }
  const allowedTopics = input.allowedTopics ??
    ["编程教程", "AI 工具使用", "效率工具", "产品设计"];
  if (
    !Array.isArray(allowedTopics) || !allowedTopics.length ||
    allowedTopics.some((x) => typeof x !== "string" || !x.trim())
  ) {
    throw new Error("必须配置非空的允许主题列表");
  }
  const additional = input.blockedTopics ?? [];
  if (
    !Array.isArray(additional) || additional.some((x) => typeof x !== "string")
  ) {
    throw new Error("排除主题必须是文本列表");
  }
  const glossary = input.glossary ?? {};
  if (
    !glossary || Array.isArray(glossary) || typeof glossary !== "object" ||
    Object.entries(glossary).some(([key, value]) =>
      !key.trim() || typeof value !== "string" || !value.trim()
    )
  ) {
    throw new Error("术语表必须是非空词条到中文译名的映射");
  }
  return {
    mode: input.mode ?? "translation",
    allowedTopics: allowedTopics.map((x) => x.trim()),
    blockedTopics: [...new Set([...REQUIRED_BLOCKED_TOPICS, ...additional])],
    glossary,
    maxCandidates: bounded(input.maxCandidates, 5, 1, 20),
    maxSourceChars: bounded(input.maxSourceChars, 24000, 1000, 40000),
    chunkChars: bounded(input.chunkChars, 2500, 500, 4000),
    minQualityScore: bounded(input.minQualityScore, 80, 60, 100),
    coverMediaId: input.coverMediaId?.trim() ?? "",
    libraryTargetSize: bounded(input.libraryTargetSize, 3, 0, 10),
    libraryMaxAgeHours: bounded(input.libraryMaxAgeHours, 72, 1, 168),
  };
}

function bounded(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`数值必须在 ${min}～${max} 之间`);
  }
  return value;
}

/** 只接受公开 HTTPS 域名，不允许内网、IP 地址、凭据及编码路径绕过。 */
export function safeSourceUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" || url.username || url.password || url.port ||
    !host.includes(".") || /[:\[\]]/.test(host) || /^[\d.]+$/.test(host) ||
    /(^|\.)(localhost|local|internal|test|invalid)$/.test(host) ||
    /%2f|%5c|%2e/i.test(url.pathname)
  ) {
    throw new Error("来源必须是无凭据的公开 HTTPS 域名地址");
  }
  url.hash = "";
  return url;
}

export async function translationKey(
  scope: string,
  value: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${scope}\n${value}`),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** 去掉仅用于统计的参数，避免同一篇库存因 RSS 跟踪参数变化被重复备稿。 */
export function canonicalArticleUrl(value: string): string {
  const url = safeSourceUrl(value);
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || /^(fbclid|gclid)$/i.test(key)) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  return url.href;
}
