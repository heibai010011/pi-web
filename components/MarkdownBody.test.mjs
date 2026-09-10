import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MarkdownBody } = await jiti.import("./MarkdownBody.tsx");
const { normalizeDisplayMath } = await jiti.import("../lib/markdown.ts");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function renderMarkdown(markdown, props = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MarkdownBody, {
        cwd: "/home/me/project",
        onOpenFile() {},
        ...props,
      }, markdown),
    ),
  );
}

test("opens non-file markdown links in a safe new tab", () => {
  const html = renderMarkdown("[docs](https://example.com/docs)");

  assert.match(
    html,
    /<a (?=[^>]*href="https:\/\/example\.com\/docs")(?=[^>]*target="_blank")(?=[^>]*rel="noopener noreferrer")[^>]*>docs<\/a>/,
  );
  assert.doesNotMatch(html, /\snode=/);
});

test("keeps local file markdown links in the app", () => {
  const relativeHtml = renderMarkdown("[file](components/MarkdownBody.tsx)");
  const fileUrlHtml = renderMarkdown("[report](file:///home/me/project/report.html)");

  assert.match(relativeHtml, /<a href="components\/MarkdownBody\.tsx">file<\/a>/);
  assert.doesNotMatch(relativeHtml, /target=|rel=|\snode=/);
  assert.match(fileUrlHtml, /<a href="file:\/\/\/home\/me\/project\/report\.html">report<\/a>/);
  assert.doesNotMatch(fileUrlHtml, /target=|rel=|\snode=/);
});

test("keeps file URLs inert without an in-app file handler", () => {
  const html = renderMarkdown("[report](file:///home/me/project/report.html)", { onOpenFile: undefined });

  assert.match(html, /<a href="" target="_blank" rel="noopener noreferrer">report<\/a>/);
});

test("keeps single-tilde CJK numeric ranges literal instead of striking them", () => {
  const html = renderMarkdown("5~7U 保证金 × 100~200倍杠杆");

  assert.doesNotMatch(html, /<del>/);
  assert.match(html, /5~7U/);
  assert.match(html, /100~200倍/);
});

test("still renders double-tilde strikethrough", () => {
  const html = renderMarkdown("~~gone~~");

  assert.match(html, /<del>gone<\/del>/);
});

test("renders backslash-escaped backticks inside inline code", () => {
  const html = renderMarkdown("`AudioManager\\`1.cs`");

  assert.match(html, /<code[^>]*>AudioManager`1\.cs<\/code>/);
  assert.doesNotMatch(html, /<\/code>1\.cs`/);
});

test("preserves legal multi-backtick spans byte-for-byte", () => {
  for (const source of ["`` `a\\`b` ``", "```a `` b \\` c```", "``line one\n`a\\`b`\nline three``"]) {
    assert.equal(normalizeDisplayMath(source), source);
    const html = renderMarkdown(source);
    assert.equal((html.match(/<code(?:\s|>)/g) ?? []).length, 1);
    assert.match(html, /\\`/);
  }
});

test("supports compatibility escaped backticks at either code edge", () => {
  for (const [source, value] of [["`\\`a`", "`a"], ["`a\\``", "a`"], ["`\\`a\\``", "`a`"], ["`AudioManager\\`1.cs`", "AudioManager`1.cs"]]) {
    assert.match(renderMarkdown(source), new RegExp(`<code[^>]*>${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}<\/code>`));
  }
});

test("normalizes same-line LaTeX without changing code or escaped ticks", () => {
  const source = "`code` 与 \\(x\\)";
  assert.equal(normalizeDisplayMath(source), "`code` 与 $x$");
  assert.match(renderMarkdown(source), /<code[^>]*>code<\/code>/);
  assert.match(renderMarkdown(source), /class="katex"/);
  assert.equal(normalizeDisplayMath("\\`\n\\(x\\)"), "\\`\n$x$");
});

test("uses actual CommonMark fence closure in blocks, lists and quotes", () => {
  for (const block of [
    "```text\nabc\n``` nope\n\\(x\\)\n```",
    "- ```text\n  \\(x\\)\n  ``` nope\n  \\(y\\)\n  ```",
    "> ```text\n> \\(x\\)\n> ``` nope\n> \\(y\\)\n> ```",
    "~~~text\n\\(x\\)\n~~~ nope\n\\(y\\)\n~~~",
  ]) {
    assert.equal(normalizeDisplayMath(block), block);
    const html = renderMarkdown(block);
    assert.doesNotMatch(html, /class="katex"/);
    assert.match(html, /\\\(x\\\)/);
    const withMath = `${block}\n\n\\(z\\)`;
    assert.equal(normalizeDisplayMath(withMath), `${block}\n\n$z$`);
    assert.match(renderMarkdown(withMath), /class="katex"/);
  }
});

test("keeps Chinese punctuation emphasis stable through streaming prefixes", () => {
  const source = "这是**重点。**后文继续";
  for (let length = 1; length <= source.length; length++) {
    const prefix = source.slice(0, length);
    assert.equal(normalizeDisplayMath(prefix), prefix);
    const html = renderMarkdown(prefix, { isStreaming: true });
    if (length >= "这是**重点。**".length) assert.match(html, /这是<strong>重点。<\/strong>/);
  }
  assert.match(renderMarkdown(source), /这是<strong>重点。<\/strong>后文继续/);
  assert.match(renderMarkdown("English **important.** then text"), /English <strong>important\.<\/strong> then text/);
  assert.doesNotMatch(renderMarkdown(String.raw`这是\*\*重点。\*\*后文`), /<strong>/);
  assert.doesNotMatch(renderMarkdown("`这是**重点。**后文`"), /<strong>/);
  assert.match(renderMarkdown("[这是**重点。**后文](https://example.com/a**b)"), /href="https:\/\/example.com\/a\*\*b"[^>]*>这是<strong>重点。<\/strong>后文<\/a>/);
});

test("streaming code and fence prefixes preserve original source", () => {
  for (const source of ["`` `a\\`b` ``", "- ```text\n  \\(x\\)\n  ``` nope\n  ```", "> ~~~\n> \\(x\\)\n> ~~~"]) {
    for (let length = 1; length <= source.length; length++) {
      const prefix = source.slice(0, length);
      assert.equal(normalizeDisplayMath(prefix), prefix);
      assert.doesNotMatch(renderMarkdown(prefix, { isStreaming: true }), /class="katex"/);
    }
  }
});

test("preserves protected text and intentional frontmatter, HTML and currency behavior", () => {
  for (const source of [
    "`` `a\\`b` ``\r\n\r\ntext",
    "\uE0000\uE000 `` `a\\`b` ``",
    "[label](https://example.com/`a\\`b`)",
    "<code>`a\\`b` \\(x\\)</code>",
    "\\[\n```\n\\(x\\)\n```\n\\]",
    "$$x\n```\n\\(x\\)\n```\n$$",
    "$$\n```\n\\(x\\)\n```\ny$$",
  ]) assert.equal(normalizeDisplayMath(source), source);
  const html = renderMarkdown("---\ntitle: hidden\n---\n\nVisible <b>HTML</b> and $5");
  assert.doesNotMatch(html, /title: hidden|<hr/);
  assert.match(html, /Visible <b>HTML<\/b> and \$5/);
  assert.doesNotMatch(renderMarkdown("```\n这是**重点。**后文\n```"), /<strong>/);
});

test("uses bounded collision-free protection tokens for arbitrary private-use text", () => {
  for (const prefix of ["\uE000".repeat(64000), "\uE0000\uE0010\uE002\uE0001\uE0017\uE002"]) {
    const source = `${prefix} $5 and \`code\``;
    assert.equal(normalizeDisplayMath(source), source);
    assert.match(renderMarkdown(source), /<code[^>]*>code<\/code>/);
  }
});

test("never absorbs code or links into inline LaTeX and retains display precedence", () => {
  for (const source of ["\\(before `code` after\\)", "\\(x [link](https://example.com) y\\)"]) {
    assert.equal(normalizeDisplayMath(source), source);
    assert.doesNotMatch(renderMarkdown(source), /class="katex"/);
  }
  assert.match(renderMarkdown("\\(before `code` after\\)"), /<code[^>]*>code<\/code>/);
  assert.match(renderMarkdown("\\(x [link](https://example.com) y\\)"), /href="https:\/\/example.com"/);
  const display = String.raw`\[\text{[x](y)}\]`;
  assert.equal(normalizeDisplayMath(display), "$$\n\\text{[x](y)}\n$$");
  assert.match(renderMarkdown(display), /class="katex-display"/);
  assert.doesNotMatch(renderMarkdown(display), /<a /);
  assert.equal(normalizeDisplayMath("\\(before `code` after\\) 与 \\(z\\)"), "\\(before `code` after\\) 与 $z$");
});

test("renders LaTeX parenthesis delimiters as inline math", () => {
  const html = renderMarkdown(String.raw`射线为 \(r_c = K^{-1}p\)。`);

  assert.match(html, /class="katex"/);
  assert.match(html, /r_c/);
});

test("renders paired LaTeX bracket delimiters as display math", () => {
  const html = renderMarkdown(String.raw`\[
P(\lambda)=o_b+\lambda r_b
\]`);
  const oneLineHtml = renderMarkdown(String.raw`\[P(\lambda)=o_b+\lambda r_b\]`);

  assert.match(html, /class="katex-display"/);
  assert.match(html, /lambda/);
  assert.match(oneLineHtml, /class="katex-display"/);
});

test("renders model-emitted bracket-only formula lines as display math", () => {
  const html = renderMarkdown(String.raw`平均一致性：

[ C(x) = \frac{2}{T(T-1)} \sum_{i<j} S(\hat{y}^{(i)}, \hat{y}^{(j)}) ]`);

  assert.match(html, /class="katex-display"/);
  assert.match(html, /\\sum/);
});

test("leaves an unmatched LaTeX bracket delimiter unchanged", () => {
  const markdown = String.raw`before
\[
x + y
after`;

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize LaTeX delimiters inside Markdown code", () => {
  const markdown = "    \\(indented\\)\n\n`code\n\\(inline\\)`\n\n```text\n\\[\nfenced\n\\]\n```";

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize LaTeX delimiters inside raw HTML code", () => {
  const markdown = "<code>\\(inline\\)</code>\n\n<pre>\n\\(block\\)\n</pre>";

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize escaped delimiters or link destinations", () => {
  const escaped = String.raw`Literal: \\(x+y\\).`;
  const link = String.raw`[docs](https://example.com/\(manual\))`;

  assert.equal(normalizeDisplayMath(escaped), escaped);
  assert.equal(normalizeDisplayMath(link), link);
});

test("previews completed Mermaid diagrams by default", () => {
  const html = renderMarkdown("```mermaid\ngraph TD\n  A --> B\n```");

  assert.match(html, /mermaid-block-loading/);
  assert.match(html, />Source</);
  assert.doesNotMatch(html, /A --&gt; B/);
});

test("keeps Mermaid source visible while the response is streaming", () => {
  const html = renderMarkdown("```mermaid\ngraph TD\n  A --> B\n```", { isStreaming: true });

  assert.doesNotMatch(html, /mermaid-block-loading/);
  assert.match(html, />Preview</);
  assert.match(html, /A --&gt; B/);
});
