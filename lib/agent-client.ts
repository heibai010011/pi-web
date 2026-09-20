// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

export class AgentCommandError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly accepted?: boolean,
  ) {
    super(message);
    this.name = "AgentCommandError";
  }
}

export function isPromptRejectedError(error: unknown): error is AgentCommandError {
  return error instanceof AgentCommandError
    && error.code === "prompt_rejected"
    && error.accepted === false;
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const parsed: unknown = await res.json().catch(() => null);
  const body = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  const errorMessage = typeof body.error === "string" ? body.error : undefined;
  if (!res.ok || body.error) {
    throw new AgentCommandError(
      errorMessage ?? `HTTP ${res.status}`,
      res.status,
      typeof body.code === "string" ? body.code : undefined,
      typeof body.accepted === "boolean" ? body.accepted : undefined,
    );
  }
  if (body.success !== true) {
    throw new AgentCommandError("Invalid agent command response", res.status);
  }
  return body.data as T;
}
