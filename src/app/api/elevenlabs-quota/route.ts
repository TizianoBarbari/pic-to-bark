import { NextRequest, NextResponse } from "next/server";
import { getClientIp, isRateLimited } from "@/lib/rateLimit";

// reads an ElevenLabs quota. With a key in the body, it's the caller's own,
// used only for this one lookup and never stored or logged. Without one, it
// falls back to the project's own key, so the app can show its own quota.
export async function POST(req: NextRequest) {
  if (isRateLimited(getClientIp(req))) {
    return NextResponse.json({ error: "slow down a bit, try again in a few minutes" }, { status: 429 });
  }

  const { key: userKey } = await req.json();
  const key = userKey || process.env.ELEVENLABS_API_KEY;
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
