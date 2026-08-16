import { NextRequest, NextResponse } from "next/server";
import { getClientIp, isRateLimited } from "@/lib/rateLimit";

// the Dog CEO image CDN doesn't send CORS headers, so the browser can't
// fetch the photo bytes directly, this fetches it server-side and hands it
// back from our own domain instead
export async function GET(req: NextRequest) {
  if (isRateLimited(getClientIp(req))) {
    return NextResponse.json({ error: "slow down a bit, try again in a few minutes" }, { status: 429 });
  }

  try {
    const listRes = await fetch("https://dog.ceo/api/breeds/image/random");
    const { message: imageUrl } = await listRes.json();

    const imgRes = await fetch(imageUrl);
    const mimeType = imgRes.headers.get("content-type") ?? "image/jpeg";
    const bytes = Buffer.from(await imgRes.arrayBuffer());

    return NextResponse.json({ image: bytes.toString("base64"), mimeType });
  } catch {
    return NextResponse.json({ error: "couldn't fetch a sample photo, try again" }, { status: 502 });
  }
}
