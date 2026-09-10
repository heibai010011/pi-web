import { defaultUrlTransform, type Options as ReactMarkdownOptions } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import { fromMarkdown } from "mdast-util-from-markdown";

const markdownSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./, "math-inline", "math-display"]],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file"],
  },
  strip: [...(defaultSchema.strip || []), "iframe", "object", "style", "form"],
};

export function markdownUrlTransform(value: string): string {
  return /^file:/i.test(value) ? value : defaultUrlTransform(value);
}

// Use the CommonMark parser's source ranges, rather than a second approximate
// fence parser. This also covers nested list/quote fences and multiline spans.
function protectCode(markdown: string, includeSingleSpans: boolean) {
  const ranges: Array<[number, number]> = [];
  const tree = fromMarkdown(markdown);
  const pending: Array<typeof tree | (typeof tree.children)[number]> = [tree];
  while (pending.length) {
    const node = pending.pop()!;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined && (
      node.type === "code" || (!includeSingleSpans && (node.type === "link" || node.type === "image" || node.type === "definition")) ||
      (node.type === "inlineCode" && (includeSingleSpans || markdown.slice(start).startsWith("``")))
    )) {
      ranges.push([start, end]);
      continue;
    }
    if ("children" in node) {
      for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i] as typeof node);
    }
  }
  // Choose a sentinel absent from the source; source text must round-trip even
  // if a user happens to paste one of our private-use characters.
  const occupied = new Set(Array.from(markdown.matchAll(/\uE000(\d+)\uE001/g), (match) => match[1]));
  let namespace = 0;
  while (occupied.has(String(namespace))) namespace++;
  const sentinel = `\uE000${namespace}\uE001`;
  const tokenPattern = `${sentinel}(\\d+)\uE002`;
  const protectedPattern = new RegExp(tokenPattern);
  const originals: string[] = [];
  let cursor = 0;
  let masked = "";
  for (const [start, end] of ranges) {
    masked += markdown.slice(cursor, start);
    masked += markdown.slice(start, end).replace(/[^\r\n]+/g, (part) => {
      const token = `${sentinel}${originals.length}\uE002`;
      originals.push(part);
      return token;
    });
    cursor = end;
  }
  masked += markdown.slice(cursor);
  return {
    masked,
    hasProtected: (line: string) => protectedPattern.test(line),
    restore(value: string) {
      return value.replace(new RegExp(tokenPattern, "g"), (_, id: string) => originals[Number(id)]);
    },
  };
}

function isEscaped(value: string, index: number): boolean {
  let count = 0;
  while (index > 0 && value[--index] === "\\") count++;
  return count % 2 === 1;
}

function rewriteEscapedInlineCodeBackticks(line: string): string {
  // A not-yet-closed multi-backtick span may be a streaming prefix. Do not
  // reinterpret its interior as our nonstandard single-tick compatibility form.
  for (const run of line.matchAll(/`{2,}/g)) {
    if (!isEscaped(line, run.index)) return line;
  }
  let result = "";
  let cursor = 0;
  for (let start = 0; start < line.length; start++) {
    if (line[start] !== "`" || isEscaped(line, start) || line[start - 1] === "`" || line[start + 1] === "`") continue;
    let end = start + 1;
    while (end < line.length && (line[end] !== "`" || isEscaped(line, end))) end++;
    if (end === line.length) break;
    // A multi-backtick delimiter belongs to CommonMark, not this compatibility
    // syntax. Never split it into single-backtick spans.
    if (line[end + 1] === "`") continue;
    const content = line.slice(start + 1, end);
    const code = content.replace(/\\`/g, "`");
    if (code !== content) {
      const marker = "`".repeat(Math.max(...(code.match(/`+/g)?.map((run) => run.length) ?? [0])) + 1);
      // CommonMark strips one surrounding space when content is not all spaces.
      // Padding prevents edge backticks merging into the delimiter run.
      const pad = code.startsWith("`") || code.endsWith("`") || (code.startsWith(" ") && code.endsWith(" ") && /\S/.test(code));
      result += line.slice(cursor, start) + marker + (pad ? " " : "") + code + (pad ? " " : "") + marker;
      cursor = end + 1;
    }
    start = end;
  }
  return result + line.slice(cursor);
}

export function normalizeDisplayMath(markdown: string): string {
  // Ordinary prose (including streaming CJK emphasis) needs no preprocessing.
  if (!/[\\$]/.test(markdown)) return markdown;
  if (!markdown.includes("\\`")) {
    const protectedCode = protectCode(markdown, true);
    return protectedCode.restore(normalizeUnprotectedMath(protectedCode.masked, protectedCode.hasProtected));
  }
  const protectedSource = protectCode(markdown, false);
  let rawTag: string | null = null;
  const rewritten = protectedSource.restore(protectedSource.masked.split("\n").map((line) => {
    const tag = rawTag ?? line.match(/<(code|pre|script|style)\b/i)?.[1]?.toLowerCase();
    if (tag) {
      rawTag = new RegExp(`</${tag}\\s*>`, "i").test(line) ? null : tag;
      return line;
    }
    // Preserve the existing conservative HTML-line policy.
    return /<(?:!--|\/?[A-Za-z][^>]*>)/.test(line) ? line : rewriteEscapedInlineCodeBackticks(line);
  }).join("\n"));
  const protectedCode = protectCode(rewritten, true);
  return protectedCode.restore(normalizeUnprotectedMath(protectedCode.masked, protectedCode.hasProtected));
}

function normalizeUnprotectedMath(markdown: string, hasProtected: (line: string) => boolean): string {
  const lineBreak = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.split(/\r?\n/);
  const normalized: string[] = [];
  let rawCodeTag: string | null = null;
  const unmatchedDisplayMathUntil = new Map<string, number>();

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    if (rawCodeTag) {
      normalized.push(line);
      if (new RegExp(`</${rawCodeTag}\\s*>`, "i").test(line)) rawCodeTag = null;
      continue;
    }

    const rawCodeOpen = line.match(/<(code|pre|script|style)\b/i);
    if (rawCodeOpen) {
      const tag = rawCodeOpen[1].toLowerCase();
      const remainder = line.slice((rawCodeOpen.index ?? 0) + rawCodeOpen[0].length);
      if (!new RegExp(`</${tag}\\s*>`, "i").test(remainder)) rawCodeTag = tag;
      normalized.push(line);
      continue;
    }

    if (/^(?: {4}|\t)/.test(line) || line.trim() === "") {
      normalized.push(line);
      continue;
    }

    if (hasProtected(line)) {
      normalized.push(normalizeInlineLatexMath(line, hasProtected));
      continue;
    }

    const bracketDisplayOneLine = line.match(/^([ ]{0,3})\\\[[ \t]*(.+?)[ \t]*\\\][ \t]*$/);
    if (bracketDisplayOneLine) {
      const math = bracketDisplayOneLine[2].trim();
      if (math) {
        // Keep the content line indented together with the `$$` fence. When the
        // formula is nested inside a GFM list item (indented `$$`), a content line
        // at column 0 becomes a "lazy continuation" line, which makes remark-math
        // mis-parse the fence pair: the opening `$$` turns into an empty math node
        // and the closing one swallows the rest of the document as math content.
        normalized.push(
          `${bracketDisplayOneLine[1]}$$`,
          `${bracketDisplayOneLine[1]}${math}`,
          `${bracketDisplayOneLine[1]}$$`,
        );
        continue;
      }
    }

    const looseBracketDisplayOneLine = line.match(/^([ ]{0,3})\[[ \t]*(.+?)[ \t]*\][ \t]*$/);
    if (looseBracketDisplayOneLine) {
      const math = looseBracketDisplayOneLine[2].trim();
      if (isLikelyMathExpression(math)) {
        normalized.push(
          `${looseBracketDisplayOneLine[1]}$$`,
          `${looseBracketDisplayOneLine[1]}${math}`,
          `${looseBracketDisplayOneLine[1]}$$`,
        );
        continue;
      }
    }

    const bracketDisplayStart = line.match(/^([ ]{0,3})\\\[[ \t]*$/);
    if (bracketDisplayStart) {
      const closingIndex = findBracketDisplayClose(lines, index + 1, hasProtected);
      if (closingIndex !== -1) {
        // Same lazy-continuation guard as above: indent content lines that sit at
        // column 0 so the block stays parseable when nested inside a list item.
        normalized.push(
          `${bracketDisplayStart[1]}$$`,
          ...lines.slice(index + 1, closingIndex).map((mathLine) =>
            indentDisplayMathContent(mathLine, bracketDisplayStart[1]),
          ),
          `${bracketDisplayStart[1]}$$`,
        );
        index = closingIndex;
        continue;
      }
    }

    const displayMathMatch = line.match(/^([ \t]{0,3})\$\$(.+)\$\$[ \t]*$/);
    if (displayMathMatch) {
      const math = displayMathMatch[2].trim();
      if (math) {
        // See the comment on bracketDisplayOneLine: without matching indentation,
        // a formula nested in a GFM list item is mis-parsed by remark-math and the
        // text after the formula renders as a garbled KaTeX error block.
        normalized.push(
          `${displayMathMatch[1]}$$`,
          `${displayMathMatch[1]}${math}`,
          `${displayMathMatch[1]}$$`,
        );
        continue;
      }
    }

    // remark-math requires both `$$` delimiters to sit on their own lines, but
    // models also emit display math as a multi-line block where the opening `$$`
    // is glued to the first formula line and/or the closing `$$` is glued to the
    // end of the last one (`$$x = 1` + `y = 2$$`). Without normalization such a
    // block swallows the following text as math content and renders as garbage.
    const displayMathMultiLine = line.match(/^([ \t]{0,3})\$\$(.+)$/);
    if (displayMathMultiLine) {
      const indent = displayMathMultiLine[1];
      const firstLine = displayMathMultiLine[2].trimEnd();
      // Only treat this as a block opener if no other `$$` is embedded mid-line
      // (e.g. `$$x$$ and text` stays untouched and is rendered as inline math).
      if (firstLine && !firstLine.includes("$$")) {
        const closing = findDisplayMathClose(
          lines,
          index + 1,
          indent,
          unmatchedDisplayMathUntil,
          hasProtected,
        );
        if (closing) {
          normalized.push(`${indent}$$`, `${indent}${firstLine}`);
          for (let j = index + 1; j < closing.index; j++) {
            normalized.push(indentDisplayMathContent(lines[j], indent));
          }
          if (closing.content) normalized.push(`${indent}${closing.content}`);
          normalized.push(`${indent}$$`);
          index = closing.index;
          continue;
        }
      }
    }

    // Bare `$$` opener (possibly indented inside a GFM list item). Two problems
    // need fixing: (1) when the closing `$$` is glued to the last content line
    // (e.g. `z = w$$`) remark-math never finds a valid closing fence and swallows
    // the rest of the document; (2) inside a list item, content lines at column 0
    // are lazy continuations that break the math flow. Both are fixed by moving
    // the closing `$$` to its own line and re-indenting lazy content lines.
    // A column-0 block with a properly detached closing `$$` is left untouched
    // (remark-math already parses it correctly).
    const displayMathBareOpen = line.match(/^([ \t]{0,3})\$\$\s*$/);
    if (displayMathBareOpen) {
      const indent = displayMathBareOpen[1];
      const closing = findDisplayMathClose(
        lines,
        index + 1,
        indent,
        unmatchedDisplayMathUntil,
        hasProtected,
      );
      if (closing && (closing.glued || indent !== "")) {
        normalized.push(`${indent}$$`);
        for (let j = index + 1; j < closing.index; j++) {
          normalized.push(indentDisplayMathContent(lines[j], indent));
        }
        if (closing.content) normalized.push(`${indent}${closing.content}`);
        normalized.push(`${indent}$$`);
        index = closing.index;
        continue;
      }
    }

    normalized.push(normalizeInlineLatexMath(line, hasProtected));
  }

  return normalized.join(lineBreak);
}

interface DisplayMathClose {
  index: number;
  content: string;
  glued: boolean;
}

function findDisplayMathClose(
  lines: string[],
  startIndex: number,
  indent: string,
  unmatchedUntil: Map<string, number>,
  hasProtected: (line: string) => boolean,
): DisplayMathClose | null {
  const knownUnmatchedUntil = unmatchedUntil.get(indent);
  if (knownUnmatchedUntil !== undefined && startIndex < knownUnmatchedUntil) return null;

  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index];
    if (isDisplayMathFence(line, indent)) return { index, content: "", glued: false };

    // A new Markdown block cannot belong to the preceding formula. In particular,
    // do not let a later sibling list item provide a closing `$$` for this block.
    if (hasProtected(line) || isDisplayMathBlockBoundary(line) || isDisplayMathOpeningLine(line)) {
      unmatchedUntil.set(indent, index);
      return null;
    }

    const content = getDisplayMathGluedCloseContent(line, indent);
    if (content !== null) return { index, content, glued: true };
  }

  // Multiple unmatched glued openers with the same indentation previously each
  // scanned to EOF. Cache this range so the overall search remains linear.
  unmatchedUntil.set(indent, lines.length);
  return null;
}

function isDisplayMathFence(line: string, indent: string): boolean {
  if (indent === "") return /^ {0,3}\$\$\s*$/.test(line);
  return line.startsWith(indent) && /^\$\$\s*$/.test(line.slice(indent.length));
}

function getDisplayMathGluedCloseContent(line: string, indent: string): string | null {
  if (!line.startsWith(indent)) return null;

  const match = line.slice(indent.length).match(/^(.+?)\$\$\s*$/);
  if (!match) return null;

  const content = match[1].trimEnd();
  return content && !content.includes("$$") ? content : null;
}

function isDisplayMathOpeningLine(line: string): boolean {
  return /^ {0,3}\$\$(?:\S|[ \t]+\S)/.test(line);
}

function isDisplayMathBlockBoundary(line: string): boolean {
  return (
    /^ {0,3}(`{3,}|~{3,})/.test(line) ||
    /^[ \t]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/.test(line) ||
    /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(line) ||
    /^ {0,3}>/.test(line) ||
    /<(code|pre|script|style)\b/i.test(line)
  );
}

function indentDisplayMathContent(line: string, indent: string): string {
  if (!indent || !line || line.startsWith("\t")) return line;

  const leadingSpaces = line.match(/^ */)?.[0].length ?? 0;
  if (leadingSpaces >= indent.length) return line;
  return `${indent.slice(leadingSpaces)}${line}`;
}

function findBracketDisplayClose(lines: string[], startIndex: number, hasProtected: (line: string) => boolean): number {
  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index];
    if (/^ {0,3}\\\][ \t]*$/.test(line)) return index;

    // Do not pair delimiters across another Markdown block boundary.
    if (
      hasProtected(line) ||
      /^ {0,3}(`{3,}|~{3,})/.test(line) ||
      /^ {0,3}\\\[[ \t]*$/.test(line) ||
      /<(code|pre|script|style)\b/i.test(line)
    ) {
      return -1;
    }
  }

  return -1;
}

function normalizeInlineLatexMath(line: string, hasProtected: (text: string) => boolean): string {
  if (
    /^\s{0,3}\[[^\]]+\]:/.test(line) ||
    /]\s*\(/.test(line) ||
    /<(?:!--|\/?[A-Za-z][^>]*>)/.test(line) ||
    /\b(?:https?|file|mailto):/i.test(line) ||
    /\b[A-Za-z]:\\/.test(line)
  ) {
    return line;
  }

  return line.replace(
    /(?<!\\)\\\(([^`\r\n$]+?)(?<!\\)\\\)/g,
    // Do not bridge a protected span: retaining the entire original pair
    // avoids turning code into KaTeX input. Other complete pairs on this line
    // can still normalize independently.
    (match, math: string) => (math.trim() && !hasProtected(math) ? `$${math}$` : match),
  );
}

function isLikelyMathExpression(value: string): boolean {
  return /\\[A-Za-z]+/.test(value) && !/\b(?:https?|file|mailto):|\b[A-Za-z]:\\|^\\\\/i.test(value);
}

// Parse YAML frontmatter into a `yaml` node before the math/GFM plugins run, so
// the raw metadata never leaks into the rendered output (without it, the opening
// `---` becomes an <hr> and the closing `---` turns the YAML into a setext heading).
// singleTilde:false requires ~~double~~ tildes for strikethrough. A single `~`
// is the standard CJK numeric-range separator (e.g. "5~7U", "100~200倍"), and
// GFM's default single-tilde strikethrough silently mangled such ranges (#385).
const remarkGfmOptions = { singleTilde: false } as const;

export const markdownRemarkPlugins: ReactMarkdownOptions["remarkPlugins"] = [
  [remarkFrontmatter, ["yaml"]],
  [remarkGfm, remarkGfmOptions],
  remarkCjkFriendly,
  remarkMath,
];
export const markdownPreviewRemarkPlugins: ReactMarkdownOptions["remarkPlugins"] = [
  [remarkFrontmatter, ["yaml"]],
  [remarkGfm, remarkGfmOptions],
  remarkCjkFriendly,
  remarkMath,
];

export const markdownRehypePlugins: ReactMarkdownOptions["rehypePlugins"] = [
  rehypeRaw,
  [rehypeSanitize, markdownSanitizeSchema],
  [rehypeKatex, { throwOnError: false, strict: false }],
];

export const markdownPreviewRehypePlugins: ReactMarkdownOptions["rehypePlugins"] = [
  rehypeRaw,
  [rehypeSanitize, markdownSanitizeSchema],
  [rehypeKatex, { throwOnError: false, strict: false }],
];
