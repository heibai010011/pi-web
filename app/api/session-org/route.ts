import { NextResponse } from "next/server";
import { normalizeSessionOrganization } from "@/lib/session-org-shape";
import { readSessionOrgProject, writeSessionOrgProject } from "@/lib/session-org-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const projectKey = new URL(req.url).searchParams.get("projectKey");
  if (!projectKey) {
    return NextResponse.json({ error: "projectKey is required" }, { status: 400 });
  }
  return NextResponse.json({ org: readSessionOrgProject(projectKey) });
}

export async function PUT(req: Request) {
  try {
    const body = await req.json() as { projectKey?: unknown; org?: unknown };
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
