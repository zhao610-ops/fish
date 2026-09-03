/** 只处理已经确认的站点模板边界，不按敏感词删减正文。 */
export function cleanArticleBody(
  content: string,
  title: string,
  sourceUrl?: string,
): string {
  if (
    sourceUrl &&
    new URL(sourceUrl).hostname.replace(/^www\./, "") === "measuringu.com"
  ) return cleanMeasuringuArticle(content, title);
  if (
    sourceUrl &&
    new URL(sourceUrl).hostname.replace(/^www\./, "") === "nngroup.com"
  ) {
    return cleanNngroupArticle(content, title);
  }
  const blocks = content.replace(/\r\n/g, "\n").split(/\n\s*\n/);
  const byline = blocks.findIndex((block) =>
    /^\[/.test(block) && block.includes("source=post_page---byline--")
  );
  if (byline < 0) return content;
  const heading = blocks.findIndex((block) =>
    /^#\s/.test(block) &&
    block.replace(/^#\s+/, "").replace(/\*\*|__/g, "").trim() === title
  );
  const share = blocks.findIndex((block, index) =>
    index > byline && block.trim() === "Share"
  );
  const actions = blocks.slice(byline, share).some((block) =>
    block.includes("source=---header_actions--")
  );
  // 边界不完整时宁可跳过，避免把正文段落误当署名删除。
  if (heading < 0 || heading >= byline || share < 0 || !actions) {
    throw new Error("文章署名模板边界不完整，无法安全分离正文");
  }
  const footer = blocks.findIndex((block, index) =>
    index > share && /^\[/.test(block) &&
    /source=post_page---(?:footer_tags|post_publication_info|post_author_info)--/
      .test(block)
  );
  const body = [
    ...blocks.slice(heading + 1, byline),
    ...blocks.slice(share + 1, footer < 0 ? undefined : footer),
  ].filter((block) =>
    block.trim() !== "Press enter or click to view image in full size"
  ).join("\n\n").trim();
  if (body.length < 300) {
    throw new Error("清理网页元信息后正文过短，跳过而不发布摘要");
  }
  return body;
}

function cleanMeasuringuArticle(content: string, title: string): string {
  const blocks = content.replace(/\r\n/g, "\n").split(/\n\s*\n/);
  const heading = blocks.findLastIndex((block) =>
    /^#\s/.test(block) && block.replace(/^#\s+/, "").trim() === title
  );
  const date = blocks.findIndex((block, index) =>
    index > heading && index <= heading + 5 &&
    /^(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}$/
      .test(block.trim())
  );
  const end = blocks.findIndex((block, index) =>
    index > date && block.trim() === "Your Cart"
  );
  const summary = blocks.findIndex((block, index) =>
    index > date && /^## Summary and Discussion\s*$/.test(block)
  );
  if (
    heading < 0 || date < 0 || summary < 0 || end <= summary + 1 ||
    !blocks.slice(end).some((block) =>
      block.includes("https://measuringu.com/shop/")
    )
  ) throw new Error("MeasuringU 正文边界无法确认，需要检查抓取结果");
  const bodyBlocks = blocks.slice(date + 1, end);
  // 已确认的购物车计数位于正文结论之后，不删除正文中的数字。
  while (bodyBlocks.at(-1)?.trim() === "0") bodyBlocks.pop();
  const body = bodyBlocks.join("\n\n").replace(
    /#### Stay informed with MeasuringU\.\n\nGet the latest research insights delivered weekly to your inbox\.\n\nEmail\n\nSubscribe\n\n/g,
    "",
  ).trim();
  if (body.length < 300) throw new Error("清理网页元信息后正文过短，拒绝发布");
  return body;
}

function cleanNngroupArticle(content: string, title: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const heading = lines.findIndex((line) =>
    /^#\s/.test(line) &&
    line.replace(/^#\s+/, "").replace(/\*\*|__/g, "").trim() === title
  );
  const start = lines.findIndex((line, index) =>
    index > heading && /^Summary:\s*$/.test(line)
  );
  const end = lines.findIndex((line, index) =>
    index > start && /^## Related Courses\s*$/.test(line)
  );
  // 页面结构不符时不猜测截取位置，也不把半篇原文放行。
  if (
    heading < 0 || start < 0 || end < 0 ||
    !/https:\/\/www\.nngroup\.com\/courses\//.test(lines.slice(end).join("\n"))
  ) {
    throw new Error("NN/g 正文边界无法确认，需要检查抓取结果");
  }
  const body = lines.slice(start, end).join("\n").trim();
  if (body.length < 300) throw new Error("清理网页元信息后正文过短，拒绝发布");
  return body;
}
