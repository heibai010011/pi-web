export interface PermissionPromptDetails {
  title: string;
  message: string;
  subagent: boolean;
  agent?: string;
  subjectLabel?: "command" | "tool" | "skill" | "path";
  subject?: string;
  target?: string;
  matchedPattern?: string;
  fullCommand?: string;
  workingDirectory?: string;
  externalPaths?: string[];
}

export interface PermissionPromptOptionMap {
  approve: string;
  approveForSession?: string;
  deny: string;
  denyWithReason?: string;
}

const PERMISSION_TITLE = /^Permission Required(?:\s*\(Subagent\))?$/i;

export function isPermissionSystemPromptTitle(rawTitle: string): boolean {
  return PERMISSION_TITLE.test(splitPermissionPromptTitle(rawTitle).title);
}

export function splitPermissionPromptTitle(rawTitle: string): { title: string; message: string } {
  const newline = rawTitle.indexOf("\n");
  if (newline < 0) return { title: rawTitle.trim(), message: "" };
  return {
    title: rawTitle.slice(0, newline).trim(),
    message: rawTitle.slice(newline + 1).trim(),
  };
}

export function getPermissionPromptOptions(options: string[]): PermissionPromptOptionMap | null {
  const approve = options.find((option) => /^Yes$/i.test(option.trim()));
  const deny = options.find((option) => /^No$/i.test(option.trim()));
  if (!approve || !deny) return null;
  return {
    approve,
    approveForSession: options.find((option) => /^Yes[,，]/i.test(option.trim())),
    deny,
    denyWithReason: options.find((option) => /^No[,，]/i.test(option.trim())),
  };
}

export function parsePermissionPrompt(title: string, options: string[]): PermissionPromptDetails | null {
  const split = splitPermissionPromptTitle(title);
  if (!PERMISSION_TITLE.test(split.title) || !split.message || !getPermissionPromptOptions(options)) return null;

  const details: PermissionPromptDetails = {
    title: split.title,
    message: split.message,
    subagent: /\(Subagent\)/i.test(split.title),
  };

  const namedAgent = split.message.match(/^Agent '([^']+)' requested /i);
  if (namedAgent) details.agent = namedAgent[1];

  const bash = split.message.match(/requested bash command '([\s\S]+?)'(?: \(matched '([^']+)'\))?(?: \(full command: '([\s\S]+)'\))?(?: which references|\. Allow| Allow)/i);
  if (bash) {
    details.subjectLabel = "command";
    details.subject = bash[1];
    if (bash[2]) details.matchedPattern = bash[2];
    if (bash[3]) details.fullCommand = bash[3];
  }

  if (!details.subject) {
    const tool = split.message.match(/requested tool '([^']+)'(?: for '([^']+)')?/i);
    if (tool) {
      details.subjectLabel = "tool";
      details.subject = tool[1];
      if (tool[2]) details.target = tool[2];
    }
  }

  if (!details.subject) {
    const skill = split.message.match(/requested (?:skill|access to skill) '([^']+)'/i);
    if (skill) {
      details.subjectLabel = "skill";
      details.subject = skill[1];
    }
  }

  const external = split.message.match(/outside working directory '([^']+)'\s*:\s*([\s\S]+?)\.\s*Allow this external directory access\?/i);
  if (external) {
    details.workingDirectory = external[1];
    details.externalPaths = external[2].split(/,\s*/).map((path) => path.trim()).filter(Boolean);
  }

  const matched = split.message.match(/\(matched '([^']+)'\)/i);
  if (!details.matchedPattern && matched) details.matchedPattern = matched[1];

  return details;
}
