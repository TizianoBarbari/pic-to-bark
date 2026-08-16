# Pic to Bark

Upload a photo of your dog. It figures out the breed, comes up with a line of what the dog is probably thinking, and reads it out loud in a voice you pick.

Built for the DEV Weekend Challenge, Dog Days edition. Going for the Snowflake, ElevenLabs, and Google AI bonus categories.

## How it works

1. Upload a photo, drag one in, or grab a random one from the [Dog CEO API](https://dog.ceo/dog-api/) if you don't have one handy. It gets downscaled and re-encoded to JPEG in the browser before anything is sent anywhere.
2. Breed detection starts right away, in the background, so pressing translate usually feels instant. Three engines to pick from:
   - Hugging Face (`google/vit-base-patch16-224`), called from the server
   - Google AI, on-device via MediaPipe, runs entirely in the browser, no server call
   - Magic Conch, a joke option that ignores the photo and answers with total confidence anyway
   - if Hugging Face or Google AI is down, it automatically retries with the other one
3. The breed gets wrapped into a short first person line, as if the dog is saying it. If the guess is shaky, the line says so instead of making one up.
4. ElevenLabs reads the line out loud, in whichever voice you pick. Changing voice afterward only regenerates the audio, not the whole guess. If ElevenLabs is unreachable everywhere, the browser's own speech synthesis reads it instead.
5. If Snowflake is configured, the breed, line, engine, and confidence get logged once per photo. You get shown how many times that breed has come up before and how this guess compares to every past one. The page also has a breed leaderboard, aggregate stats, an hourly trend, a check on whether the random punchline picker is actually uniform, and the most recent translations.

Running low on API quota? Open "use your own API keys" to paste in your own Hugging Face and/or ElevenLabs key, kept in the browser tab only, never saved anywhere. There's also a button to check how much ElevenLabs quota that key has left.

## Running it

Copy `.env.local.example` to `.env.local` and fill in your keys:

```
HUGGINGFACE_API_KEY=your key from huggingface.co
ELEVENLABS_API_KEY=your key from elevenlabs.io
```

The Snowflake variables are optional; without them the app just skips logging.

Then:

```bash
npm install
npm run dev
```

Open http://localhost:3000.

First request on the Hugging Face path can be slow since the model needs to wake up. The Google AI path is slower on the very first run too, since it has to download the on-device model, but nothing after that touches the network.

If you're using Snowflake, the tables need to exist first:

```sql
CREATE DATABASE IF NOT EXISTS pic_to_bark;
USE DATABASE pic_to_bark;

CREATE TABLE IF NOT EXISTS translations (
  id INT AUTOINCREMENT PRIMARY KEY,
  breed STRING,
  caption STRING,
  engine STRING,
  confidence FLOAT,
  created_at TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

CREATE TABLE IF NOT EXISTS suggestions (
  id INT AUTOINCREMENT PRIMARY KEY,
  text STRING,
  created_at TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);
```

## Seeding sample data

Optional, run by hand, not part of the app. `scripts/seed.ts` pulls real dog photos from the Dog CEO API, runs them through the real Hugging Face classifier and caption logic, and logs them to Snowflake:

```bash
npm install -D tsx
npx tsx scripts/seed.ts 20
```

## Security

API keys are only ever read server-side, inside API routes, never exposed to the browser. Routes that call paid or quota-limited services are rate limited per IP.

## Stack

Next.js, Tailwind, Hugging Face and MediaPipe (Google AI) for breed detection, ElevenLabs for text to speech, Snowflake for logging and stats.