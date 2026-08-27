import assert from "node:assert/strict";
import test from "node:test";
import { getPermissionPromptOptions, isPermissionSystemPromptTitle, parsePermissionPrompt, splitPermissionPromptTitle } from "./permission-prompt.ts";

test("splits the permission title from its long prompt message", () => {
  assert.deepEqual(
    splitPermissionPromptTitle("Permission Required\nCurrent agent requested tool 'read'. Allow this call?"),
    { title: "Permission Required", message: "Current agent requested tool 'read'. Allow this call?" },
  );
});

test("parses a bash permission prompt into readable fields", () => {
  const details = parsePermissionPrompt(
    "Permission Required\nCurrent agent requested bash command 'rm -rf /tmp/demo' (matched 'rm -rf *') (full command: 'rm -rf /tmp/demo 2>&1; echo done'). Allow this command?",
    ["Yes", "Yes, allow \"rm *\" for this session", "No", "No, provide reason"],
  );
  assert.deepEqual(details, {
    title: "Permission Required",
    message: "Current agent requested bash command 'rm -rf /tmp/demo' (matched 'rm -rf *') (full command: 'rm -rf /tmp/demo 2>&1; echo done'). Allow this command?",
    subagent: false,
    subjectLabel: "command",
    subject: "rm -rf /tmp/demo",
    matchedPattern: "rm -rf *",
    fullCommand: "rm -rf /tmp/demo 2>&1; echo done",
  });
});

test("parses external path and subagent prompts", () => {
  const details = parsePermissionPrompt(
    "Permission Required (Subagent)\nAgent 'reviewer' requested bash command 'cat /tmp/a' which references path(s) outside working directory 'C:\\repo': /tmp/a, /tmp/b. Allow this external directory access?",
    ["Yes", "Yes, for this session", "No", "No, provide reason"],
  );
  assert.equal(details?.subagent, true);
  assert.equal(details?.agent, "reviewer");
  assert.equal(details?.subject, "cat /tmp/a");
  assert.equal(details?.workingDirectory, "C:\\repo");
  assert.deepEqual(details?.externalPaths, ["/tmp/a", "/tmp/b"]);
});

test("recognizes permission decisions without depending on session label wording", () => {
  assert.deepEqual(
    getPermissionPromptOptions(["Yes", "Yes, allow \"git status *\" for this session", "No", "No, provide reason"]),
    {
      approve: "Yes",
      approveForSession: "Yes, allow \"git status *\" for this session",
      deny: "No",
      denyWithReason: "No, provide reason",
    },
  );
  assert.equal(getPermissionPromptOptions(["Alpha", "Beta"]), null);
});

test("identifies permission prompts before their message has been parsed", () => {
  assert.equal(isPermissionSystemPromptTitle("Permission Required\nlong request"), true);
  assert.equal(isPermissionSystemPromptTitle("Permission Required (Subagent)\nlong request"), true);
  assert.equal(isPermissionSystemPromptTitle("Choose a model"), false);
});

test("does not claim unrelated extension selects", () => {
  assert.equal(parsePermissionPrompt("Choose a model", ["Yes", "No"]), null);
});
