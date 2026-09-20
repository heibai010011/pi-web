import { NextResponse } from "next/server";
import { normalizeSessionOrganization } from "@/lib/session-org-shape";
import { readSessionOrgProjectEntry, writeSessionOrgProject } from "@/lib/session-org-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const projectKey = new URL(req.url).searchParams.get("projectKey");
  if (!projectKey) {
    return NextResponse.json({ error: "projectKey is required" }, { status: 400 });
  }
  return NextResponse.json(readSessionOrgProjectEntry(projectKey));
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
    const projectKey = typeof body.projectKey === "string" ? body.projectKey : null;
    if (!projectKey) {
      return NextResponse.json({ error: "projectKey is required" }, { status: 400 });
    }
    const org = normalizeSessionOrganization(body.org);
    if (!org) {
      return NextResponse.json({ error: "invalid org payload" }, { status: 400 });
    }
    writeSessionOrgProject(projectKey, org);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
