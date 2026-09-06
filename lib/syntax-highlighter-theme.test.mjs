import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { darkSyntaxTheme, lightSyntaxTheme } = await jiti.import("./syntax-highlighter-theme.ts");

const preSelector = 'pre[class*="language-"]';

for (const [name, theme] of [
  ["light", lightSyntaxTheme],
  ["dark", darkSyntaxTheme],
]) {
  test(`${name} syntax theme leaves the pre background to customStyle`, () => {
    const preStyle = theme[preSelector];

    assert.equal(Object.hasOwn(preStyle, "background"), false);
    assert.equal(Object.hasOwn(preStyle, "backgroundColor"), false);
  });
}
