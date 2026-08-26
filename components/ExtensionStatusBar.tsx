"use client";

import { type MouseEvent } from "react";
import { parseAnsiLine, stripAnsi } from "@/lib/ansi";
import { resolveLocalFileHref } from "@/lib/file-links";
import type { ExtensionStatusItem, ExtensionWidgetItem } from "@/lib/types";
import { AnsiText } from "./AnsiText";
import { ExtensionWidgets } from "./ExtensionWidgets";

export function sanitizeExtensionStatusText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\t/g, " ").replace(/ +/g, " ").trim())
    .join("\n")
    .trim();
}

export function formatExtensionStatusLine(statuses: ExtensionStatusItem[]): string {
  return [...statuses]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ text }) => sanitizeExtensionStatusText(text))
    .join(" ");
}

/** True when the line carries OSC 8 file:// links this fork makes clickable. */
function hasLocalFileLinks(statusLine: string): boolean {
  return statusLine.includes("\x1b]8;;file://");
}

export function ExtensionStatusBar({
  statuses,
  widgets = [],
  onOpenFile,
}: {
  statuses: ExtensionStatusItem[];
  widgets?: ExtensionWidgetItem[];
  onOpenFile?: (filePath: string) => void;
}) {
  if (statuses.length === 0 && widgets.length === 0) return null;

  const statusLine = formatExtensionStatusLine(statuses);
  const plainStatusLine = stripAnsi(statusLine);

  const renderSegmentLink = (
    segment: ReturnType<typeof parseAnsiLine>[number],
    index: number,
  ) => {
    if (!segment.link) {
      return <span key={index} style={segment.style}>{segment.text}</span>;
    }

    const filePath = resolveLocalFileHref(segment.link);
    const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
      if (!filePath || !onOpenFile) return;
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onOpenFile(filePath);
    };

    return (
      <a
        key={index}
        href={segment.link}
        target="_blank"
        rel="noopener noreferrer"
        onClick={handleClick}
        style={{ ...segment.style, textDecoration: "underline" }}
      >
        {segment.text}
      </a>
    );
  };

  return (
    <div
      className={`extension-status-shelf${widgets.length > 0 ? " has-widgets" : ""}${statuses.length > 0 ? " has-status" : ""}`}
    >
      {widgets.length > 0 && <ExtensionWidgets widgets={widgets} />}
      {statuses.length > 0 && (
        <div
          role="status"
          className="extension-status-line"
          aria-label={plainStatusLine}
          title={plainStatusLine}
        >
          <span className="extension-status-text">
            {/* ansi_up covers the full SGR set faithfully; local file://
                hyperlinks fall back to parseAnsiLine so clicking opens the
                file tab instead of a raw browser navigation. */}
            {hasLocalFileLinks(statusLine)
              ? parseAnsiLine(statusLine).map(renderSegmentLink)
              : <AnsiText text={statusLine} />}
          </span>
        </div>
      )}
    </div>
  );
}
