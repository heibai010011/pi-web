import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { buildSubagentPromptPlan } = await createJiti(import.meta.url).import("./subagent-prompt.ts");

function assertDelegatedReport(actual, taskWithContext) {
  assert.ok(actual.startsWith(`${taskWithContext}\n\nFinal report to the parent:`));
  const report = actual.slice(taskWithContext.length);
  assert.match(report, /self-contained/);
  assert.match(report, /findings, supporting evidence, artifact paths when applicable/);
  assert.match(report, /verification performed \(or not performed\)/);
  assert.match(report, /unresolved items or limitations/);
  assert.match(report, /proportionate to the task/);
  assert.match(report, /respect any requested output format/);
  assert.equal(report.match(/Final report to the parent:/g)?.length, 1);
}

test("a tool-free subagent uses only its profile as the exact system prompt", () => {
  const plan = buildSubagentPromptPlan({
    profileSystemPrompt: "Review carefully.",
    tools: [],
    task: "Inspect the parser.",
    inheritedParentContext: "Parent context",
  });

  assert.equal(plan.chatOnly, true);
  assert.equal(plan.exactSystemPrompt, "Review carefully.");
  assert.deepEqual(plan.appendSystemPrompt, ["Review carefully."]);
  assertDelegatedReport(plan.delegatedTask, "Inspect the parser.\n\nParent context");
});

test("a tool-enabled subagent retains inherited context in its appended system prompt", () => {
  const plan = buildSubagentPromptPlan({
    profileSystemPrompt: "Explore carefully.",
    tools: ["read"],
    task: "Inspect the parser.",
    inheritedParentContext: "Parent context",
  });

  assert.equal(plan.chatOnly, false);
  assert.equal(plan.exactSystemPrompt, undefined);
  assert.deepEqual(plan.appendSystemPrompt, ["Explore carefully.", "Parent context"]);
  assertDelegatedReport(plan.delegatedTask, "Inspect the parser.");
});

test("a resource-enabled tool-free subagent keeps the normal system prompt pipeline", () => {
  for (const resources of [
    { loadSkills: true, loadExtensions: false },
    { loadSkills: false, loadExtensions: true },
  ]) {
    const plan = buildSubagentPromptPlan({
      profileSystemPrompt: "Use loaded resources.",
      tools: [],
      ...resources,
      task: "Inspect the parser.",
      inheritedParentContext: "Parent context",
    });

    assert.equal(plan.chatOnly, false);
    assert.equal(plan.exactSystemPrompt, undefined);
    assert.deepEqual(plan.appendSystemPrompt, ["Use loaded resources.", "Parent context"]);
    assertDelegatedReport(plan.delegatedTask, "Inspect the parser.");
  }
});

test("replace prompt mode makes the profile body the exact system prompt", () => {
  const plan = buildSubagentPromptPlan({
    profileSystemPrompt: "Only these instructions.",
    tools: ["read"],
    promptMode: "replace",
    task: "Inspect the parser.",
  });
  assert.equal(plan.exactSystemPrompt, "Only these instructions.");
  assert.deepEqual(plan.appendSystemPrompt, ["Only these instructions."]);
  assertDelegatedReport(plan.delegatedTask, "Inspect the parser.");
});

test("reporting guidance preserves custom system prompts byte-for-byte across prompt modes", () => {
  for (const tools of [[], ["read"]]) {
    for (const promptMode of ["replace", "append"]) {
      for (const profileSystemPrompt of ["", "  Custom instructions.\nReturn JSON only.\n"]) {
        const plan = buildSubagentPromptPlan({
          profileSystemPrompt,
          tools,
          promptMode,
          task: "Return the findings as JSON.",
          inheritedParentContext: "Parent context",
        });
        const chatOnly = tools.length === 0;
        assert.equal(plan.exactSystemPrompt,
          chatOnly || promptMode === "replace" ? profileSystemPrompt : undefined);
        assert.deepEqual(plan.appendSystemPrompt,
          chatOnly ? [profileSystemPrompt] : [profileSystemPrompt, "Parent context"]);
        assertDelegatedReport(plan.delegatedTask,
          chatOnly ? "Return the findings as JSON.\n\nParent context" : "Return the findings as JSON.");
      }
    }
  }
});
