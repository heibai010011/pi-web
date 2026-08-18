import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./ansi.ts");
}

test("strips ANSI escape sequences", async () => {
  const { stripAnsi } = await loadSubject();

  assert.equal(stripAnsi("\x1b[31mred\x1b[0m plain"), "red plain");
  assert.equal(stripAnsi("answer\x1b_pi:c\x07"), "answer");
});

test("normalizes boxed custom panel lines while preserving ANSI codes", async () => {
  const { normalizeCustomPanelLines, stripAnsi } = await loadSubject();
  const lines = [
    "┌──────┐",
    "│ \x1b[32mOK\x1b[0m   │",
    "└──────┘",
  ];

  const normalized = normalizeCustomPanelLines(lines);

  assert.equal(normalized.length, 1);
  assert.equal(stripAnsi(normalized[0]), "OK");
  assert.match(normalized[0], /\x1b\[32m/);
});

test("removes pi-tui cursor markers from custom panel output", async () => {
  const { normalizeCustomPanelLines } = await loadSubject();

  assert.deepEqual(normalizeCustomPanelLines(["> value\x1b_pi:c\x07"]), ["> value"]);
});

test("parses ANSI style segments and reset codes", async () => {
  const { parseAnsiLine } = await loadSubject();

  assert.deepEqual(parseAnsiLine("\x1b[31;1mhot\x1b[0m cold"), [
    { text: "hot", style: { color: "#dc2626", fontWeight: 700 } },
    { text: " cold", style: {} },
  ]);
});

test("maps 256-color SGR codes", async () => {
  const { ansi256Color, parseAnsiLine } = await loadSubject();

  assert.equal(ansi256Color(196), "rgb(255, 0, 0)");
  assert.deepEqual(parseAnsiLine("\x1b[38;5;196mred"), [
    { text: "red", style: { color: "rgb(255, 0, 0)" } },
  ]);
});

test("parses OSC 8 hyperlinks (ST terminator)", async () => {
  const { parseAnsiLine } = await loadSubject();

  const line = "\x1b]8;;file:///C:/Users/heibai/.dsh/profiles/web/pnpm-workspace.yaml\x1b\\pnpm-workspace.yaml\x1b]8;;\x1b\\ 1W";
  assert.deepEqual(parseAnsiLine(line), [
    {
      text: "pnpm-workspace.yaml",
      style: {},
      link: "file:///C:/Users/heibai/.dsh/profiles/web/pnpm-workspace.yaml",
    },
    { text: " 1W", style: {} },
  ]);
});

test("parses OSC 8 hyperlinks (BEL terminator)", async () => {
  const { parseAnsiLine } = await loadSubject();

  const line = "\x1b]8;;https://example.com\x07home\x1b]8;;\x07 page";
  assert.deepEqual(parseAnsiLine(line), [
    { text: "home", style: {}, link: "https://example.com" },
    { text: " page", style: {} },
  ]);
});

test("keeps SGR styles inside OSC 8 hyperlinks", async () => {
  const { parseAnsiLine } = await loadSubject();

  const line = "\x1b]8;;file:///tmp/a.ts\x1b\\\x1b[31ma.ts\x1b[0m\x1b]8;;\x1b\\ done";
  assert.deepEqual(parseAnsiLine(line), [
    { text: "a.ts", style: { color: "#dc2626" }, link: "file:///tmp/a.ts" },
    { text: " done", style: {} },
  ]);
});

test("stripAnsi removes OSC 8 hyperlinks without eating text between open and close", async () => {
  const { stripAnsi } = await loadSubject();

  const line = "\x1b]8;;file:///C:/x.yaml\x1b\\x.yaml\x1b]8;;\x1b\\ 1W";
  assert.equal(stripAnsi(line), "x.yaml 1W");
});
