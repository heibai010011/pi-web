import { NextResponse } from "next/server";
import { runNpx } from "@/lib/npx";
import type { SkillSearchResult } from "@/lib/api-types";

export const dynamic = "force-dynamic";

const ANSI_RE = /\x1B\[[0-9;]*m/g;
const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;
const SEARCH_API_BASE = process.env.SKILLS_API_URL || "https://skills.sh";

interface SkillsApiSkill {
  id?: string;
  name?: string;
  source?: string;
  installs?: number;
}

function normalizeApiSkill(value: unknown): SkillsApiSkill | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  return {
    name: typeof raw.name === "string" ? raw.name : undefined,
    source: typeof raw.source === "string" ? raw.source : undefined,
    id: typeof raw.id === "string" ? raw.id : undefined,
    installs: typeof raw.installs === "number" && Number.isFinite(raw.installs) && raw.installs > 0 ? raw.installs : 0,
  };
}

function parseLimit(value: unknown): number {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return DEFAULT_LIMIT;
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.floor(num)));
}

function formatInstalls(count?: number): string {
  if (!count || count <= 0) return "";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M installs`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K installs`;
  return `${count} install${count === 1 ? "" : "s"}`;
}

function parseSearchOutput(raw: string): SkillSearchResult[] {
  const clean = raw.replace(ANSI_RE, "");
  const results: SkillSearchResult[] = [];
  const lines = clean.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // package line: "owner/repo@skill  NNK installs"
    const pkgMatch = line.match(/^([\w.\-]+\/[\w.\-@:]+)\s+([\d.,]+[KMB]?\s+installs?)$/);
    if (pkgMatch) {
      const urlLine = lines[i + 1]?.trim().replace(/^└\s*/, "");
      results.push({
        package: pkgMatch[1],
        installs: pkgMatch[2],
        url: urlLine?.startsWith("https://") ? urlLine : "",
      });
    }
  }
  return results;
}

async function searchSkillsApi(query: string, limit: number): Promise<SkillSearchResult[]> {
  const url = `${SEARCH_API_BASE}/api/search?q=${encodeURIComponent(query)}&limit=${limit}`;
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`skills.sh search failed: HTTP ${res.status}`);

  const data: unknown = await res.json();
  if (!data || typeof data !== "object" || !Array.isArray((data as { skills?: unknown }).skills)) {
    throw new Error("Invalid skills search response");
  }
  return ((data as { skills: unknown[] }).skills)
    .map(normalizeApiSkill)
    .filter((skill): skill is SkillsApiSkill => skill !== null)
    .sort((a, b) => (b.installs ?? 0) - (a.installs ?? 0))
    .map((skill) => {
      const name = skill.name?.trim();
      const source = skill.source?.trim();
      const slug = skill.id?.trim();
      if (!name || (!source && !slug)) return null;

      const pkg = `${source || slug}@${name}`;
      return {
        package: pkg,
        installs: formatInstalls(skill.installs),
        url: slug ? `${SEARCH_API_BASE}/${slug}` : "",
      };
    })
    .filter((skill): skill is SkillSearchResult => skill !== null)
    .slice(0, limit);
}


// POST /api/skills/search  body: { query: string, limit?: number }
export async function POST(req: Request) {
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
  const { query, limit: rawLimit } = body;
  if (typeof query !== "string" || !query.trim()) return NextResponse.json({ error: "query required" }, { status: 400 });
  const limit = parseLimit(rawLimit);
  try {
    try {
      const results = await searchSkillsApi(query.trim(), limit);
      return NextResponse.json({ results });
    } catch {
      const { stdout, stderr } = await runNpx(["skills", "find", query.trim()], {
        timeout: 20000,
        env: { ...process.env, FORCE_COLOR: "0" },
      });

      const results = parseSearchOutput(`${stdout}\n${stderr}`).slice(0, limit);
      return NextResponse.json({ results });
    }
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const raw = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
    const results = raw ? parseSearchOutput(raw).slice(0, limit) : [];
    if (results.length > 0) return NextResponse.json({ results });
    return NextResponse.json({ error: err.message ?? String(e) }, { status: 500 });
  }
}
