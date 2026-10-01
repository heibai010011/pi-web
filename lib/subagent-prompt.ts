export interface SubagentPromptPlan {
  chatOnly: boolean;
  appendSystemPrompt: string[];
  delegatedTask: string;
  exactSystemPrompt?: string;
}

export function withSubagentReportContract(task: string): string {
  const instruction = "Final report to the parent: make it self-contained, with findings, supporting evidence, artifact paths when applicable, verification performed (or not performed), and unresolved items or limitations. Keep the detail proportionate to the task and respect any requested output format.";
  return `${task}\n\n${instruction}`;
}

export function buildSubagentPromptPlan(options: {
  profileSystemPrompt: string;
  tools: readonly string[];
  loadSkills?: boolean;
  loadExtensions?: boolean;
  promptMode?: "replace" | "append";
  task: string;
  inheritedParentContext?: string;
}): SubagentPromptPlan {
  const chatOnly = options.tools.length === 0 && !options.loadSkills && !options.loadExtensions;
  const replacePrompt = options.promptMode === "replace";
  const appendSystemPrompt = [options.profileSystemPrompt];
  if (options.inheritedParentContext && !chatOnly) {
    appendSystemPrompt.push(options.inheritedParentContext);
  }
  const taskWithContext = options.inheritedParentContext && chatOnly
    ? `${options.task}\n\n${options.inheritedParentContext}`
    : options.task;
  // Keep custom/replace system prompts exact; reporting belongs to the delegated task.
  return {
    chatOnly,
    appendSystemPrompt,
    delegatedTask: withSubagentReportContract(taskWithContext),
    ...(chatOnly || replacePrompt ? { exactSystemPrompt: options.profileSystemPrompt } : {}),
  };
}
