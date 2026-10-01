import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { MessageView } = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function render(overrides = {}, props = {}) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(MessageView, {
      message: {
        role: "custom", customType: "pi-web:subagent-notification", display: true,
        content: "**Saved child findings**", details: {
          kind: "pi-web-subagent", sessionId: "child-123", description: "Inspect notification flow", status: "completed",
        }, ...overrides,
      }, ...props,
    })));
}

test("built-in notification is a compact native disclosure, collapsed by default", () => {
  const html = render({}, { onOpenSession() {} });
  assert.match(html, /^<details\s/);
  assert.doesNotMatch(html.match(/^<details[^>]*>/)[0], /\bopen=/);
  assert.match(html, /Inspect notification flow/);
  assert.match(html, /Child: Completed/);
  assert.match(html, /Child report — not the parent’s final answer/);
  assert.match(html, /<strong>Saved child findings<\/strong>/);
  assert.match(html, /<button[^>]*>Open sub-agent session<\/button>/);
  assert.doesNotMatch(html, /parent.*(?:processing|completed)|retry/i);
});

test("delivery failure is visibly distinct from child success and provides honest recovery", () => {
  const html = render({ customType: "pi-web:subagent-delivery-error", details: {
    sessionId: "child-123", description: "Inspect notification flow", status: "completed", error: "Parent was unavailable",
  } }, { onOpenSession() {} });
  assert.match(html, /^<details open=""/);
  assert.match(html, /Parent notification \/ continuation failed/);
  assert.match(html, /Child: Completed/);
  assert.match(html, /Parent was unavailable/);
  assert.match(html, /Ask the parent to continue using the saved sub-agent result/);
  assert.doesNotMatch(html, /retry/i);
});

test("historical details without a kind and block-array content remain supported", () => {
  const html = render({ details: { sessionId: "old-child", description: "Old task", status: "failed" }, content: [{ type: "text", text: "Historical **report**" }] }, { onOpenSession() {} });
  assert.match(html, /Old task/);
  assert.match(html, /Child: Failed/);
  assert.match(html, /Historical <strong>report<\/strong>/);
  assert.match(html, /Open sub-agent session/);
});

test("missing and malformed details safely fall back without an invalid child action", () => {
  for (const details of [undefined, null, false, 3, "invalid", [], { description: {}, status: [], sessionId: 5, error: {} }]) {
    const html = render({ details }, { onOpenSession() {} });
    assert.match(html, /Sub-agent task/);
    assert.match(html, /Child: Unknown/);
    assert.match(html, /Saved child findings/);
    assert.doesNotMatch(html, /<button/);
  }
  assert.doesNotMatch(render(), /Open sub-agent session/);
  assert.match(render({ details: { status: "future-status" } }), /Child: Unknown/);
});

test("unrelated custom messages retain the generic extension presentation", () => {
  for (const customType of ["other:subagent-notification", "pi-web:subagent-notification-extra", "extension-message"]) {
    const html = render({ customType });
    assert.doesNotMatch(html, /^<details\s/);
    assert.doesNotMatch(html, /Child report —/);
    assert.match(html, /Saved child findings/);
  }
});
