export type Prediction = { label: string; score: number };

const CLASSIFY_MODEL = "google/vit-base-patch16-224"; // ImageNet classifier, includes most dog breeds

// Hugging Face models can be asleep the first time you call them. If so it
// tells us how long to wait, so we wait once and try again instead of failing.
async function callHF(hfKey: string, init: RequestInit) {
  const url = `https://router.huggingface.co/hf-inference/models/${CLASSIFY_MODEL}`;
  const headers = { Authorization: `Bearer ${hfKey}`, ...init.headers };

  let res = await fetch(url, { ...init, headers });

  if (res.status === 503) {
    const body = await res.json();
    const wait = Math.min(body.estimated_time ?? 15, 20);
    await new Promise((r) => setTimeout(r, wait * 1000));
    res = await fetch(url, { ...init, headers });
  }

  return res;
}

export async function classifyWithHF(imageBytes: Buffer, mimeType: string, hfKey: string): Promise<Prediction[]> {
  const res = await callHF(hfKey, {
    method: "POST",
    headers: { "Content-Type": mimeType },
    body: new Uint8Array(imageBytes),
  });

  if (!res.ok) {
    const detail = await res.text();
    console.error("classify model failed", res.status, detail);
    throw new Error("couldn't look at that photo, try another one");
  }

  return res.json();
}
