import { NextRequest, NextResponse } from "next/server";
import { logSuggestion } from "@/lib/snowflake";
import { getClientIp, isRateLimited } from "@/lib/rateLimit";

export async function POST(req: NextRequest) {
  if (isRateLimited(getClientIp(req))) {
    return NextResponse.json({ error: "slow down a bit, try again in a few minutes" }, { status: 429 });
  }

  const { text } = await req.json();
  if (typeof text !== "string" || !text.trim()) {
    return NextResponse.json({ error: "write something first" }, { status: 400 });
  }

  await logSuggestion(text.trim().slice(0, 500));
  return NextResponse.json({ ok: true });
}
