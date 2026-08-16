// premade ElevenLabs voices confirmed available on the free plan for this account
export const VOICES = [
  { id: "N2lVS1w4EtoT3dr4eOWO", label: "Trickster (Callum)" },
  { id: "FGY2WhTYpPnrIDTdsKH5", label: "Sassy (Laura)" },
  { id: "IKne3meq5aSn9XLyUdCD", label: "Energetic (Charlie)" },
  { id: "SOYHLrjzK2X1ezoPC6cr", label: "Fierce (Harry)" },
  { id: "CwhRBWXzGAHq8TQ4Fs17", label: "Laid-back (Roger)" },
] as const;

export const DEFAULT_VOICE_ID = VOICES[0].id;

export function isValidVoiceId(id: unknown): id is string {
  return typeof id === "string" && VOICES.some((v) => v.id === id);
}
