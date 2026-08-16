import { NextRequest } from "next/server";

const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 15;

// in-memory, per running process: good enough to stop someone from
// accidentally (or not) hammering the free-tier API quotas from a single
// IP. Not a hard guarantee on serverless, where concurrent requests can
// land on different, memory-isolated instances, but it's real protection
// for the common case and costs nothing to run.
const hits = new Map<string, number[]>();

export function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  return forwarded ? forwarded.split(",")[0].trim() : "unknown";
}

export function isRateLimited(id: string): boolean {
  const now = Date.now();
  const recent = (hits.get(id) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(id, recent);
  return recent.length > MAX_REQUESTS;
}
