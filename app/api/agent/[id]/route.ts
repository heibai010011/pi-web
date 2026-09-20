import { parsePromptRequestId, promptCancellation, PromptCancellationError } from "@/lib/prompt-cancellation";
import { NextResponse } from "next/server";
import { ImageGenerationValidationError, validateImageReferenceCount } from "@/lib/image-gen";
import { resolveSessionPath } from "@/lib/session-reader";
import { startRpcSession, getRpcSession, setRpcSessionTools } from "@/lib/rpc-manager";

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let commandType: string | undefined;
  let promptAccepted = false;

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };
    commandType = typeof body.type === "string" ? body.type : undefined;
    const requestId = parsePromptRequestId(body.promptRequestId);
    if (requestId && body.type !== "prompt" && body.type !== "abort") throw new PromptCancellationError("promptRequestId is only supported for prompt/abort", 400);
    if (requestId && body.streamingBehavior !== undefined) throw new PromptCancellationError("Correlated prompts cannot use streamingBehavior", 400);
    if (requestId && body.type === "abort") {
      // Tombstone first, before path resolution or startup. Abort-only never starts a wrapper.
      promptCancellation.cancel(id, requestId);
      const owner = getRpcSession(id);
      if (owner?.isAlive()) {
        if (owner.promptCancellationVersion !== 1) throw new PromptCancellationError("Session predates request cancellation; stop and reload the session, then retry");
        await owner.send(body);
      }
      return NextResponse.json({ success: true, data: null });
    }
    if (requestId) promptCancellation.available(id, requestId);
    // Reject oversized submissions before startup can touch session persistence.
    if (body.type === "image_generate") validateImageReferenceCount(body.images);
    const requestedToolNames = body.toolNames;
    if (
      requestedToolNames !== undefined
      && (!Array.isArray(requestedToolNames) || requestedToolNames.some((name) => typeof name !== "string"))
    ) {
      throw new Error("toolNames must be an array of strings");
    }
    const toolNames = requestedToolNames as string[] | undefined;

    // Fast path: already-running session
    const existing = getRpcSession(id);
    if (body.type === "set_tools") {
      const filePath = existing?.sessionFile || await resolveSessionPath(id) || undefined;
      if (!existing?.isAlive() && !filePath) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      const changed = await setRpcSessionTools(id, filePath, toolNames);
      return NextResponse.json({
        success: true,
        data: { sessionId: changed.sessionId, recreated: changed.recreated },
      });
    }
    if (existing?.isAlive()) {
      if (requestId && existing.promptCancellationVersion !== 1) throw new PromptCancellationError("Session predates request cancellation; stop and reload the session, then retry");
      const result = await existing.send(body);
      promptAccepted = body.type === "prompt";
      return NextResponse.json({ success: true, data: result });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({
        error: "Session not found",
        ...(body.type === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 404 });
    }

    if (requestId) promptCancellation.available(id, requestId);
    const { session } = await startRpcSession(id, filePath, undefined, {
      ...(toolNames !== undefined ? { toolNames } : {}),
    });
    if (requestId) {
      promptCancellation.available(id, requestId);
      if (session.promptCancellationVersion !== 1) throw new PromptCancellationError("Session predates request cancellation; stop and reload the session, then retry");
    }
    const result = await session.send(body);
    promptAccepted = body.type === "prompt";

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: error instanceof PromptCancellationError || error instanceof ImageGenerationValidationError ? error.status : 500 });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      return NextResponse.json({ running: false });
    }

    const state = await session.send({ type: "get_state" });
    return NextResponse.json({ running: true, state });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
