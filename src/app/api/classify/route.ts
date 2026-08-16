import { NextRequest, NextResponse } from "next/server";
import { classifyWithHF } from "@/lib/hfClassify";
import { getClientIp, isRateLimited } from "@/lib/rateLimit";

export async function POST(req: NextRequest) {
  if (isRateLimited(getClientIp(req))) {
    return NextResponse.json({ error: "slow down a bit, try again in a few minutes" }, { status: 429 });
  }

  const { image, mimeType, hfKey: userHfKey } = await req.json();

  if (!image || !mimeType) {
    return NextResponse.json({ error: "upload a photo first" }, { status: 400 });
  }

  const hfKey = userHfKey || process.env.HUGGINGFACE_API_KEY;
  if (!hfKey) {
    console.error("missing HUGGINGFACE_API_KEY");
    return NextResponse.json({ error: "the app isn't set up yet" }, { status: 500 });
  }

  try {
    const predictions = await classifyWithHF(Buffer.from(image, "base64"), mimeType, hfKey);
    return NextResponse.json({ predictions });
  } catch {
    return NextResponse.json({ error: "couldn't look at that photo, try another one" }, { status: 502 });
  }
}
