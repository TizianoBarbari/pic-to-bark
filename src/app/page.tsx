"use client";

import { useEffect, useRef, useState } from "react";
import { DEFAULT_VOICE_ID, VOICES } from "@/lib/voices";
import { classifyOnDevice } from "@/lib/mediapipeClassify";
import type { Prediction } from "@/lib/hfClassify";

type Engine = "hf" | "google" | "chaos";

// picks a random, wildly confident, usually wrong answer, no photo required
const CHAOS_LABELS = [
  "cosmic terrier",
  "sentient meatball",
  "quantum chihuahua",
  "dog-shaped cloud",
  "cat, allegedly",
  "loaf of bread",
  "ancient prophecy",
  "very good bicycle",
  "rare shadow beagle",
  "legally distinct mickey mouse",
  "cryptid",
  "small horse",
  "sentient sock",
  "government surveillance drone",
  "screaming void",
];

function engineName(eng: Engine) {
  if (eng === "google") return "Google AI";
  if (eng === "chaos") return "Magic Conch";
  return "Hugging Face";
}

async function runChaos(): Promise<Prediction[]> {
  const label = CHAOS_LABELS[Math.floor(Math.random() * CHAOS_LABELS.length)];
  return [{ label, score: 0.97 + Math.random() * 0.03 }];
}

const AUTOPLAY_KEY = "bt-autoplay";
const AUTOPLAY_HINT_SEEN_KEY = "bt-autoplay-hint-seen";

// So the "Sniffing out the breed" indicator doesn't flash by unseen when
// Google AI (on-device, often faster than a single frame) answers instantly
const MIN_PREFETCH_MS = 300;

const MAX_UPLOAD_DIMENSION = 1024;

// sanity check: every photo gets downscaled before it's sent anywhere
const MAX_FILE_SIZE = 50 * 1024 * 1024;

// Downscales and re-encodes as JPEG before it ever leaves the browser. 
// The classifiers only look at a few hundred pixels internally anyway.
function resizeToBase64(file: File, maxDim = MAX_UPLOAD_DIMENSION): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("no canvas context"));
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.85).split(",")[1]);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("couldn't read that image"));
    };
    img.src = url;
  });
}

function readLocalFlag(key: string, defaultValue: boolean) {
  if (typeof window === "undefined") return defaultValue;
  const stored = window.localStorage.getItem(key);
  return stored === null ? defaultValue : stored === "true";
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// identifies a selected file well enough for caching purposes, without reading its bytes
function fileKey(f: File) {
  return `${f.name}:${f.size}:${f.lastModified}`;
}

function cacheKey(f: File, eng: Engine) {
  return `${eng}:${fileKey(f)}`;
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [voiceId, setVoiceId] = useState<string>(DEFAULT_VOICE_ID);
  const [engine, setEngine] = useState<Engine>("hf");
  const [loading, setLoading] = useState(false);
  const [voiceLoading, setVoiceLoading] = useState(false);
  const [caption, setCaption] = useState<string | null>(null);
  const [breedCount, setBreedCount] = useState<{ breed: string; count: number } | null>(null);
  const [percentile, setPercentile] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoplay, setAutoplay] = useState(() => readLocalFlag(AUTOPLAY_KEY, true));
  const [showAutoplayHint, setShowAutoplayHint] = useState(false);
  const [leaderboard, setLeaderboard] = useState<{ breed: string; count: number }[]>([]);
  const [stats, setStats] = useState<{
    total: number;
    uniqueBreeds: number;
    hfCount: number;
    googleCount: number;
    chaosCount: number;
    uncertainCount: number;
  } | null>(null);
  const [recent, setRecent] = useState<{ breed: string; caption: string }[]>([]);
  const [punchlines, setPunchlines] = useState<{ punchline: string; count: number }[]>([]);
  const [hourly, setHourly] = useState<{ hour: string; count: number }[]>([]);
  const [loggedPairs, setLoggedPairs] = useState<Set<string>>(() => new Set());
  const [revealMode, setRevealMode] = useState(false);
  // own API keys, kept in memory only, never persisted, sent only on the request that needs them
  const [userHfKey, setUserHfKey] = useState("");
  const [userElevenLabsKey, setUserElevenLabsKey] = useState("");
  const [elevenLabsQuota, setElevenLabsQuota] = useState<{ used: number; limit: number } | null>(null);
  const [voiceFailed, setVoiceFailed] = useState(false);
  const [suggestion, setSuggestion] = useState("");
  const [suggestionSent, setSuggestionSent] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Keep the cache in state so derived values stay in sync with renders.
  const [cache, setCache] = useState<Map<string, Prediction[]>>(() => new Map());
  const [failedSet, setFailedSet] = useState<Set<string>>(() => new Set());
  // if the requested engine is down, we quietly try the other one instead of
  // just failing; this remembers when that happened so reveal mode can be honest about it
  const [fallbackInfo, setFallbackInfo] = useState<Map<string, Engine>>(() => new Map());

  function getCached(f: File, eng: Engine) {
    return cache.get(cacheKey(f, eng));
  }

  function setCached(f: File, eng: Engine, preds: Prediction[]) {
    setCache((prev) => new Map(prev).set(cacheKey(f, eng), preds));
  }

  function markFailed(f: File, eng: Engine) {
    setFailedSet((prev) => new Set(prev).add(cacheKey(f, eng)));
  }

  function markFallback(f: File, requested: Engine, used: Engine) {
    setFallbackInfo((prev) => new Map(prev).set(cacheKey(f, requested), used));
  }

  // how long the actual classification call took, not counting the artificial
  // MIN_PREFETCH_MS floor below, purely for the "peek behind the curtain" panel
  const [timings, setTimings] = useState<Map<string, number>>(() => new Map());

  function setTiming(f: File, eng: Engine, ms: number) {
    setTimings((prev) => new Map(prev).set(cacheKey(f, eng), ms));
  }

  const predictions = file ? getCached(file, engine) ?? null : null;
  const fallbackTo = file ? fallbackInfo.get(cacheKey(file, engine)) : undefined;
  const failed = file ? failedSet.has(cacheKey(file, engine)) : false;
  const prefetching = Boolean(file && !predictions && !failed);
  const timing = file ? timings.get(cacheKey(file, engine)) : undefined;

  // Cache generated audio by caption and voice.
  const [audioCache, setAudioCache] = useState<Map<string, string>>(() => new Map());

  function audioCacheKey(cap: string, voice: string) {
    return `${voice}:${cap}`;
  }

  function getCachedAudio(cap: string, voice: string) {
    return audioCache.get(audioCacheKey(cap, voice));
  }

  function setCachedAudio(cap: string, voice: string, url: string) {
    setAudioCache((prev) => new Map(prev).set(audioCacheKey(cap, voice), url));
  }

  async function runGoogle(): Promise<Prediction[]> {
    if (!imgRef.current) throw new Error("no image");
    await imgRef.current.decode();
    return classifyOnDevice(imgRef.current);
  }

  async function runHF(f: File): Promise<Prediction[]> {
    const image = await resizeToBase64(f);
    const res = await fetch("/api/classify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image, mimeType: "image/jpeg", hfKey: userHfKey || undefined }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data.predictions;
  }

  function runEngine(eng: Engine, f: File): Promise<Prediction[]> {
    if (eng === "google") return runGoogle();
    if (eng === "chaos") return runChaos();
    return runHF(f);
  }

  // Fall back to the other real classifier if the requested one fails. The
  // chaos engine is pure local randomness, it can't fail, so it never falls
  // back and never gets used as a fallback target for the other two.
  async function classifyWithFallback(f: File, requested: Engine) {
    if (requested === "chaos") {
      return { preds: await runChaos(), usedEngine: requested };
    }
    try {
      return { preds: await runEngine(requested, f), usedEngine: requested };
    } catch (err) {
      const fallbackEngine: Engine = requested === "google" ? "hf" : "google";
      console.error(`[classify] ${requested} failed, trying ${fallbackEngine} instead`, err);
      const preds = await runEngine(fallbackEngine, f);
      return { preds, usedEngine: fallbackEngine };
    }
  }

  function refreshLeaderboard() {
    fetch("/api/leaderboard")
      .then((res) => res.json())
      .then((data) => setLeaderboard(data.leaderboard ?? []))
      .catch(() => {});
  }

  function refreshStats() {
    fetch("/api/stats")
      .then((res) => res.json())
      .then((data) => {
        setStats(data.stats ?? null);
        setRecent(data.recent ?? []);
        setPunchlines(data.punchlines ?? []);
        setHourly(data.hourly ?? []);
      })
      .catch(() => {});
  }

  useEffect(() => {
    refreshLeaderboard();
    refreshStats();
  }, []);

  // Warm up the on-device classifier so switching engines is instant.
  // No cleanup/cancellation: results are cached under the file+engine pair
  // even if the user has already moved on.
  useEffect(() => {
    if (!file || getCached(file, "google")) return;
    const currentFile = file;

    console.log("[classify] warming up google ai in background for", currentFile.name);
    runGoogle()
      .then((preds) => {
        console.log("[classify] google ai background result cached");
        setCached(currentFile, "google", preds);
      })
      .catch((err) => console.error("[classify] google ai background prefetch failed", err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  // Precompute the selected classifier result.
  useEffect(() => {
    if (!file) return;

    if (getCached(file, engine)) {
      console.log(`[classify] cache hit for ${engine}, no call made`);
      return;
    }
    if (failedSet.has(cacheKey(file, engine))) return;

    const currentFile = file;
    const currentEngine = engine;
    console.log(`[classify] calling ${currentEngine}...`);

    const start = Date.now();
    const timedClassify = classifyWithFallback(currentFile, currentEngine).then((result) => ({
      ...result,
      elapsedMs: Date.now() - start,
    }));

    Promise.all([timedClassify, wait(MIN_PREFETCH_MS)])
      .then(([{ preds, usedEngine, elapsedMs }]) => {
        console.log(`[classify] ${usedEngine} done in ${elapsedMs}ms`);
        setCached(currentFile, currentEngine, preds);
        setTiming(currentFile, currentEngine, elapsedMs);
        if (usedEngine !== currentEngine) markFallback(currentFile, currentEngine, usedEngine);
      })
      .catch((err) => {
        console.error(`[classify] both engines failed`, err);
        markFailed(currentFile, currentEngine);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, engine]);

  function handleFile(f: File | null) {
    if (f && f.size > MAX_FILE_SIZE) {
      setError("that file is too big to be a normal photo, try a different one");
      return;
    }

    setFile(f);
    setCaption(null);
    setBreedCount(null);
    setPercentile(null);
    setVoiceFailed(false);
    setAudioUrl(null);
    setError(null);
    setPreview(f ? URL.createObjectURL(f) : null);
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    handleFile(e.target.files?.[0] ?? null);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    handleFile(e.dataTransfer.files?.[0] ?? null);
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
  }

  async function trySampleDog() {
    try {
      const res = await fetch("/api/sample-dog");
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "couldn't fetch a sample photo, try again");
        return;
      }
      const blob = await (await fetch(`data:${data.mimeType};base64,${data.image}`)).blob();
      handleFile(new File([blob], "sample-dog.jpg", { type: data.mimeType }));
    } catch {
      setError("couldn't fetch a sample photo, try again");
    }
  }

  function submitSuggestion() {
    if (!suggestion.trim()) return;
    fetch("/api/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: suggestion.trim() }),
    })
      .then(() => {
        setSuggestion("");
        setSuggestionSent(true);
      })
      .catch(() => {});
  }

  function setAutoplayPref(value: boolean) {
    setAutoplay(value);
    setShowAutoplayHint(false);
    window.localStorage.setItem(AUTOPLAY_KEY, String(value));
    window.localStorage.setItem(AUTOPLAY_HINT_SEEN_KEY, "true");
  }

  function dismissAutoplayHint() {
    setShowAutoplayHint(false);
    window.localStorage.setItem(AUTOPLAY_HINT_SEEN_KEY, "true");
  }

  function copyCaption() {
    if (!caption) return;
    navigator.clipboard.writeText(caption).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  function checkElevenLabsQuota() {
    if (!userElevenLabsKey) return;
    fetch("/api/elevenlabs-quota", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: userElevenLabsKey }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (typeof data.used === "number") setElevenLabsQuota({ used: data.used, limit: data.limit });
      })
      .catch(() => {});
  }

  function speakInBrowser(text: string) {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }

  // src is set declaratively via the <audio> element's src prop below.
  // Assigning audioRef.current.src imperatively here would trigger a second
  // load when React commits the same value, potentially aborting an in-flight
  // play() call.
  useEffect(() => {
    if (!audioUrl || !autoplay || !audioRef.current) return;

    audioRef.current
      .play()
      .then(() => {
        if (!readLocalFlag(AUTOPLAY_HINT_SEEN_KEY, false)) {
          setShowAutoplayHint(true);
        }
      })
      .catch((err) => {
        // Autoplay may be blocked if the user gesture is no longer considered active.
        console.error("[autoplay] blocked:", err);
      });
  }, [audioUrl, autoplay]);

  async function onTranslate() {
    if (!file) return;
    setLoading(true);
    setError(null);
    setCaption(null);
    setBreedCount(null);
    setPercentile(null);
    setVoiceFailed(false);
    setAudioUrl(null);

    try {
      // Always go through the same fallback-aware path used for prefetching,
      // so a cold click (before the cache has a result yet) still gets the
      // same HF/Google AI safety net instead of a one-shot server call.
      let preds = predictions;
      let actualEngine = fallbackTo ?? engine;
      if (!preds) {
        const result = await classifyWithFallback(file, engine);
        preds = result.preds;
        actualEngine = result.usedEngine;
        if (result.usedEngine !== engine) markFallback(file, engine, result.usedEngine);
      }

      // Only log the first translation for each photo/engine pair.
      const pairKey = cacheKey(file, engine);
      const alreadyLogged = loggedPairs.has(pairKey);
      const body: Record<string, unknown> = {
        voiceId,
        logIt: !alreadyLogged,
        engine: actualEngine,
        predictions: preds,
        elevenLabsKey: userElevenLabsKey || undefined,
      };

      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "something went wrong, try again");
        return;
      }

      setCaption(data.caption);
      if (data.breed && typeof data.breedCount === "number") {
        setBreedCount({ breed: data.breed, count: data.breedCount });
      }
      if (typeof data.percentile === "number") {
        setPercentile(data.percentile);
      }
      if (data.audio) {
        const blob = await (await fetch(`data:audio/mpeg;base64,${data.audio}`)).blob();
        const url = URL.createObjectURL(blob);
        setAudioUrl(url);
        setCachedAudio(data.caption, voiceId, url);
        setVoiceFailed(false);
        if (userElevenLabsKey) checkElevenLabsQuota();
      } else if (data.audioError) {
        setError("all voice quotas are exhausted right now, using a browser backup voice instead");
        setVoiceFailed(true);
        if (autoplay) speakInBrowser(data.caption);
      }

      if (!alreadyLogged) {
        setLoggedPairs((prev) => new Set(prev).add(pairKey));
        refreshLeaderboard();
        refreshStats();
      }
    } catch {
      setError("something went wrong, try again");
    } finally {
      setLoading(false);
    }
  }

  async function onVoiceChange(id: string) {
    setVoiceId(id);
    if (!caption) return;

    const cachedAudio = getCachedAudio(caption, id);
    if (cachedAudio) {
      setAudioUrl(cachedAudio);
      return;
    }

    setVoiceLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caption, voiceId: id, elevenLabsKey: userElevenLabsKey || undefined }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "something went wrong, try again");
        return;
      }

      if (data.audio) {
        const blob = await (await fetch(`data:audio/mpeg;base64,${data.audio}`)).blob();
        const url = URL.createObjectURL(blob);
        setAudioUrl(url);
        setCachedAudio(caption, id, url);
        setVoiceFailed(false);
        if (userElevenLabsKey) checkElevenLabsQuota();
      } else if (data.audioError) {
        setError("all voice quotas are exhausted right now, using a browser backup voice instead");
        setVoiceFailed(true);
        if (autoplay) speakInBrowser(caption);
      }
    } catch {
      setError("something went wrong, try again");
    } finally {
      setVoiceLoading(false);
    }
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-2xl font-bold">Pic to Bark</h1>
      <p className="text-zinc-500 text-center max-w-sm">
        Upload a photo of your dog and hear what (s)he is thinking.
      </p>

      <div
        onDrop={onDrop}
        onDragOver={onDragOver}
        className="flex flex-col items-center gap-3 border-2 border-dashed border-zinc-200 rounded p-4"
      >
        <label className="cursor-pointer px-4 py-2 rounded border border-zinc-300 text-sm hover:bg-zinc-50">
          {file ? "choose a different photo" : "Choose a photo, or drag one here"}
          <input type="file" accept="image/*" onChange={onFileChange} className="sr-only" />
        </label>

        <p className="text-xs text-zinc-500">
          <button onClick={trySampleDog} className="underline">
            No dog handy? Try a random one
          </button>{" "}
          (via{" "}
          <a href="https://dog.ceo/dog-api/" target="_blank" rel="noopener noreferrer" className="underline">
            Dog CEO API
          </a>
          )
        </p>

        {preview && (
          // eslint-disable-next-line @next/next/no-img-element
          <img ref={imgRef} src={preview} alt="preview" className="max-w-xs rounded" />
        )}
      </div>

      {prefetching && <p className="text-xs text-zinc-400">Sniffing out the breed...</p>}

      {failed && (
        <p className="text-xs text-red-500">
          {revealMode
            ? "couldn't reach either model, try again"
            : "hmm, having trouble reading this photo, try again"}
        </p>
      )}

      <div className="flex gap-4 w-full max-w-sm">
        <label className="flex flex-col items-center gap-1 text-sm text-zinc-600 flex-1 min-w-0">
          breed detection
          <select
            value={engine}
            onChange={(e) => setEngine(e.target.value as Engine)}
            className="border rounded px-2 py-1 w-full"
          >
            <option value="hf">Hugging Face</option>
            <option value="google">Google AI (on-device)</option>
            <option value="chaos">Magic Conch (chaos mode)</option>
          </select>
        </label>

        <label className="flex flex-col items-center gap-1 text-sm text-zinc-600 flex-1 min-w-0">
          voice
          <select
            value={voiceId}
            disabled={voiceLoading}
            onChange={(e) => onVoiceChange(e.target.value)}
            className="border rounded px-2 py-1 w-full disabled:opacity-40"
          >
            {VOICES.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap justify-center gap-x-6 gap-y-2">
        <label className="flex items-center gap-2 text-sm text-zinc-600">
          <input
            type="checkbox"
            checked={autoplay}
            onChange={(e) => setAutoplayPref(e.target.checked)}
          />
          autoplay
        </label>

        <label className="flex items-center gap-2 text-sm text-zinc-600">
          <input
            type="checkbox"
            checked={revealMode}
            onChange={(e) => setRevealMode(e.target.checked)}
          />
          peek behind the curtain
        </label>
      </div>

      {fallbackTo && (
        <p className="text-xs text-zinc-500 text-center max-w-xs">
          {engineName(engine)} was unavailable, used {engineName(fallbackTo)} instead
        </p>
      )}

      {revealMode && predictions && (
        <div className="text-xs text-zinc-500 border border-dashed rounded px-3 py-2 w-full max-w-xs">
          <p className="font-medium mb-1">{engineName(fallbackTo ?? engine)} says:</p>
          {typeof timing === "number" && <p className="mb-1">answered in {timing}ms</p>}
          <ul>
            {predictions.slice(0, 5).map((p) => (
              <li key={p.label} className="flex justify-between gap-2">
                <span className="truncate">{p.label.split(",")[0]}</span>
                <span>{Math.round(p.score * 100)}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="text-sm text-zinc-500 w-full max-w-xs">
        <summary className="cursor-pointer text-center">Use your own API keys (mine run out fast!)</summary>
        <div className="flex flex-col gap-2 mt-2">
          <div className="text-xs">
            <p className="font-medium">Hugging Face</p>
            <p>
              <a href="https://huggingface.co/join" target="_blank" rel="noopener noreferrer" className="underline">
                sign up
              </a>{" "}
              or{" "}
              <a href="https://huggingface.co/login" target="_blank" rel="noopener noreferrer" className="underline">
                log in
              </a>
              , then{" "}
              <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noopener noreferrer" className="underline">
                create a token
              </a>{" "}
              (preset &quot;Inference&quot;)
            </p>
          </div>
          <div className="text-xs">
            <p className="font-medium">ElevenLabs</p>
            <p>
              <a href="https://elevenlabs.io/app/sign-up" target="_blank" rel="noopener noreferrer" className="underline">
                sign up
              </a>{" "}
              or{" "}
              <a href="https://elevenlabs.io/app/sign-in" target="_blank" rel="noopener noreferrer" className="underline">
                log in
              </a>
              , then{" "}
              <a href="https://elevenlabs.io/app/developers/api-keys" target="_blank" rel="noopener noreferrer" className="underline">
                create an API key
              </a>{" "}
              with Text to Speech access
            </p>
          </div>
          <input
            type="password"
            placeholder="Hugging Face key"
            value={userHfKey}
            onChange={(e) => setUserHfKey(e.target.value)}
            className="border rounded px-2 py-1 text-xs"
          />
          <input
            type="password"
            placeholder="ElevenLabs key"
            value={userElevenLabsKey}
            onChange={(e) => {
              setUserElevenLabsKey(e.target.value);
              setElevenLabsQuota(null);
            }}
            className="border rounded px-2 py-1 text-xs"
          />
          {userElevenLabsKey && (
            <div className="flex items-center gap-2">
              <button onClick={checkElevenLabsQuota} className="text-xs underline">
                check quota
              </button>
              {elevenLabsQuota && (
                <span className="text-xs">
                  {elevenLabsQuota.used} / {elevenLabsQuota.limit} characters used
                </span>
              )}
            </div>
          )}
          <p className="text-xs">Kept in this tab only, never saved, sent only when you translate</p>
        </div>
      </details>

      <button
        onClick={onTranslate}
        disabled={!file || loading}
        className="px-4 py-2 rounded bg-black text-white disabled:opacity-40"
      >
        {loading ? "Translating..." : "Translate"}
      </button>

      {error && <p className="text-red-600">{error}</p>}

      {caption && (
        <div key={caption} className="wag-in flex flex-col items-center gap-3 max-w-sm text-center">
          <p className="text-lg italic">&quot;{caption}&quot;</p>
          <button onClick={copyCaption} className="text-xs underline text-zinc-400">
            {copied ? "copied!" : "copy"}
          </button>
          {breedCount && (
            <p className="text-xs text-zinc-400">
              {breedCount.breed} guessed {breedCount.count} time{breedCount.count === 1 ? "" : "s"}
              {stats && stats.total > 0 && ` out of ${stats.total} translations so far`}
            </p>
          )}
          {typeof percentile === "number" && (
            <p className="text-xs text-zinc-400">more confident than {percentile}% of other guesses</p>
          )}
          {audioUrl && userElevenLabsKey && (
            <p className="text-xs text-zinc-400">used your own ElevenLabs key for this</p>
          )}
          {audioUrl && <audio ref={audioRef} controls src={audioUrl} />}
          {voiceFailed && (
            <button onClick={() => speakInBrowser(caption)} className="text-xs underline text-zinc-400">
              hear it in a robot voice instead
            </button>
          )}
          {voiceLoading && <p className="text-xs text-zinc-400">switching voice...</p>}

          {showAutoplayHint && (
            <div className="flex items-center gap-2 text-xs text-zinc-500 bg-zinc-100 rounded px-3 py-2">
              <span>plays automatically. don&apos;t like it?</span>
              <button onClick={() => setAutoplayPref(false)} className="underline">
                turn off
              </button>
              <button onClick={dismissAutoplayHint} aria-label="dismiss" className="text-zinc-400">
                ×
              </button>
            </div>
          )}
        </div>
      )}

      {leaderboard.length > 0 && (
        <div className="text-sm text-zinc-500 text-center">
          <p className="font-medium">most guessed breeds so far</p>
          <ol>
            {leaderboard.map((entry) => (
              <li key={entry.breed}>
                {entry.breed} ({entry.count})
              </li>
            ))}
          </ol>
        </div>
      )}

      {stats && stats.total > 0 && (
        <div className="text-sm text-zinc-500 text-center">
          <p className="font-medium">stats</p>
          <p>
            {stats.total} translations, {stats.uniqueBreeds} unique breeds
          </p>
          <p>
            {stats.hfCount} via Hugging Face, {stats.googleCount} via Google AI, {stats.chaosCount} via Magic Conch
          </p>
          <p>{Math.round((stats.uncertainCount / stats.total) * 100)}% of the time it admitted it wasn&apos;t sure</p>
        </div>
      )}

      {punchlines.length > 0 && (
        <div className="text-sm text-zinc-500 text-center">
          <p className="font-medium">punchline distribution</p>
          <ul>
            {punchlines.map((p) => (
              <li key={p.punchline}>
                {p.punchline}: {p.count}
              </li>
            ))}
          </ul>
        </div>
      )}

      {hourly.length > 0 && (
        <div className="text-sm text-zinc-500 text-center w-full max-w-sm">
          <p className="font-medium mb-1">translations per hour</p>
          <div className="flex flex-col gap-1">
            {hourly.slice(-24).map((h) => (
              <div key={h.hour} className="flex items-center gap-2 text-xs">
                <span className="w-32 text-right shrink-0">{h.hour}</span>
                <div className="flex-1 bg-zinc-100 h-3 rounded">
                  <div
                    className="bg-zinc-400 h-3 rounded"
                    style={{ width: `${(h.count / Math.max(...hourly.map((x) => x.count))) * 100}%` }}
                  />
                </div>
                <span className="w-4">{h.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {recent.length > 0 && (
        <div className="text-sm text-zinc-500 text-center max-w-sm">
          <p className="font-medium">recent translations</p>
          <ul>
            {recent.map((r, i) => (
              <li key={i}>
                {r.breed}: &quot;{r.caption}&quot;
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="text-sm text-zinc-500 text-center w-full max-w-sm">
        <p className="font-medium">Suggestions for improvements</p>
        {suggestionSent ? (
          <p className="text-xs">Thanks, noted!</p>
        ) : (
          <div className="flex flex-col items-center gap-2 mt-1">
            <textarea
              value={suggestion}
              onChange={(e) => setSuggestion(e.target.value.slice(0, 500))}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") submitSuggestion();
              }}
              placeholder="what would make this better? (ctrl+enter to send)"
              rows={2}
              className="border rounded px-2 py-1 text-xs w-full"
            />
            <button onClick={submitSuggestion} className="text-xs underline">
              Send
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
