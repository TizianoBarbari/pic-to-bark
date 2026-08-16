// One-off utility: pulls real dog photos, runs them through the real
// classifier and caption logic, and logs them to Snowflake, so the stats
// page has real data instead of looking empty. Not part of the app itself.
//
// Usage: npm install -D tsx, then npx tsx scripts/seed.ts [count]

import { readFileSync } from "node:fs";
import { classifyWithHF } from "../src/lib/hfClassify";
import { toDogLine, breedName } from "../src/lib/dogLine";
import { logTranslation } from "../src/lib/snowflake";

// .env.local isn't loaded automatically outside of `next dev`, so read it by hand
for (const line of readFileSync(".env.local", "utf-8").split("\n")) {
  const match = line.match(/^([A-Z_]+)=(.*)$/);
  if (match) process.env[match[1]] ??= match[2];
}

const COUNT = Number(process.argv[2] ?? 20);
const DELAY_MS = 800;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchDogPhoto() {
  const listRes = await fetch("https://dog.ceo/api/breeds/image/random");
  const { message: imageUrl } = await listRes.json();
  const imgRes = await fetch(imageUrl);
  const mimeType = imgRes.headers.get("content-type") ?? "image/jpeg";
  const bytes = Buffer.from(await imgRes.arrayBuffer());
  return { bytes, mimeType };
}

async function main() {
  const hfKey = process.env.HUGGINGFACE_API_KEY;
  if (!hfKey) throw new Error("missing HUGGINGFACE_API_KEY in .env.local");

  for (let i = 1; i <= COUNT; i++) {
    try {
      const { bytes, mimeType } = await fetchDogPhoto();
      const predictions = await classifyWithHF(bytes, mimeType, hfKey);
      const breed = breedName(predictions);
      const caption = toDogLine(predictions);

      if (breed) {
        const topScore = predictions[0]?.score ?? null;
        await logTranslation(breed, caption, "hf", topScore);
        console.log(`[seed] ${i}/${COUNT} ${breed}: ${caption}`);
      } else {
        console.log(`[seed] ${i}/${COUNT} skipped, model wasn't confident enough`);
      }
    } catch (err) {
      console.error(`[seed] ${i}/${COUNT} failed`, err);
    }

    await wait(DELAY_MS);
  }
}

main();
