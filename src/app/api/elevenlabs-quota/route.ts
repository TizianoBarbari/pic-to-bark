import { NextRequest, NextResponse } from "next/server";
import { getClientIp, isRateLimited } from "@/lib/rateLimit";

// reads the caller's own ElevenLabs quota, the key is only used for this one
// lookup and never stored or logged
export async function POST(req: NextRequest) {
  if (isRateLimited(getClientIp(req))) {
    return NextResponse.json({ error: "slow down a bit, try again in a few minutes" }, { status: 429 });
  }

  const { key } = await req.json();
  if (!key) {
    return NextResponse.json({ error: "missing key" }, { status: 400 });
  }

  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": key },
    });

    if (!res.ok) {
      return NextResponse.json({ error: "couldn't check that key" }, { status: 502 });
    }

    const data = await res.json();
    return NextResponse.json({ used: data.character_count, limit: data.character_limit });
  } catch {
    return NextResponse.json({ error: "couldn't check that key" }, { status: 502 });
  }
}
