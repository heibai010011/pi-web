import { NextResponse } from "next/server";
import { ModelsConfigReadError, readModelsConfig, writeModelsConfig } from "@/lib/models-config-store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(readModelsConfig());
  } catch (error) {
    if (error instanceof ModelsConfigReadError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ error: "Body must be a JSON object" }, { status: 400 });
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    writeModelsConfig(body);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ModelsConfigReadError) {
      return NextResponse.json({ error: "Unable to read the existing model configuration. Fix it before saving." }, { status: 409 });
    }
    return NextResponse.json({ error: "Unable to save model configuration. Check the configuration file and its permissions." }, { status: 500 });
  }
}
