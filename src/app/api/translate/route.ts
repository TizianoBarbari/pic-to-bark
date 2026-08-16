import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_VOICE_ID, isValidVoiceId } from "@/lib/voices";
import type { Prediction } from "@/lib/hfClassify";
import { toDogLine, breedName } from "@/lib/dogLine";
import { logTranslation, getBreedCount, getConfidencePercentile } from "@/lib/snowflake";
import { getClientIp, isRateLimited } from "@/lib/rateLimit";

async function textToSpeech(text: string, voiceId: string, elevenLabsKey: string) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": elevenLabsKey,
    },
    body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
  });

  if (!res.ok) {
    const detail = await res.text();
    console.error("Elevenlabs request failed", res.status, detail);
    // quota running out doesn't get better on retry, so don't tell people to try again
    if (detail.includes("quota_exceeded")) {
      throw new Error("Out of voice quota for now :( Here's the line anyway");
    }
    throw new Error("Couldn't generate the voice, try again");
  }

  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString("base64");
}

// a failed voice generation (quota, outage) shouldn't throw away a caption
// that was already produced, so this always resolves rather than throwing
async function tryTextToSpeech(text: string, voiceId: string, elevenLabsKey: string) {
  try {
    return { audio: await textToSpeech(text, voiceId, elevenLabsKey), audioError: null };
  } catch (err) {
    return { audio: null, audioError: err instanceof Error ? err.message : "couldn't generate the voice" };
  }
}

export async function POST(req: NextRequest) {
  if (isRateLimited(getClientIp(req))) {
    return NextResponse.json({ error: "Slow down a bit, try again in a few minutes" }, { status: 429 });
  }

  const {
    voiceId,
    predictions,
    caption: existingCaption,
    logIt,
    engine,
    elevenLabsKey: userElevenLabsKey,
  } = await req.json();

  const usedEngine = engine === "google" || engine === "hf" || engine === "chaos" ? engine : null;

  const elevenLabsKey = userElevenLabsKey || process.env.ELEVENLABS_API_KEY;
  if (!elevenLabsKey) {
    console.error("Missing ELEVENLABS_API_KEY");
    return NextResponse.json({ error: "The app isn't set up yet" }, { status: 500 });
  }

  const voice = isValidVoiceId(voiceId) ? voiceId : DEFAULT_VOICE_ID;

  try {
    if (typeof existingCaption === "string" && existingCaption) {
      const { audio, audioError } = await tryTextToSpeech(existingCaption, voice, elevenLabsKey);
      return NextResponse.json({ caption: existingCaption, audio, audioError });
    }

    if (!Array.isArray(predictions) || !predictions.length) {
      return NextResponse.json({ error: "Couldn't figure out what's in that photo" }, { status: 502 });
    }

    const typedPredictions = predictions as Prediction[];
    const caption = toDogLine(typedPredictions);
    const breed = breedName(typedPredictions);
    const topScore = typedPredictions[0]?.score ?? null;

    const [{ audio, audioError }, extra] = await Promise.all([
      tryTextToSpeech(caption, voice, elevenLabsKey),
      (async () => {
        if (!breed) return { breedCount: null, percentile: null };
        if (logIt !== false) await logTranslation(breed, caption, usedEngine, topScore);
        const [breedCount, percentile] = await Promise.all([
          getBreedCount(breed),
          topScore !== null ? getConfidencePercentile(topScore) : Promise.resolve(null),
        ]);
        return { breedCount, percentile };
      })(),
    ]);

    return NextResponse.json({
      caption,
      breed,
      audio,
      audioError,
      breedCount: extra.breedCount,
      percentile: extra.percentile,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "something went wrong, try again";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
