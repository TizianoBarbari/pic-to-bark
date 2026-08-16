import { FilesetResolver, ImageClassifier } from "@mediapipe/tasks-vision";

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/image_classifier/efficientnet_lite0/float32/1/efficientnet_lite0.tflite";

// the WASM runtime grabs a reference to console.error once, when it loads,
// and reuses it for every log line after that. So this has to run before
// the module is loaded at all, not around individual calls, or it's too late.
// It only swallows lines matching TFLite's own diagnostic log format
// (INFO:, or glog-style "W0815 12:34:56...") and lets anything else through.
if (typeof window !== "undefined") {
  const w = window as unknown as { __btConsolePatched?: boolean };
  if (!w.__btConsolePatched) {
    w.__btConsolePatched = true;
    const originalError = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      const msg = String(args[0] ?? "");
      if (/^(INFO:|[IWEF]\d{4} )/.test(msg)) return;
      originalError(...args);
    };
  }
}

let classifierPromise: Promise<ImageClassifier> | null = null;

function getClassifier() {
  if (!classifierPromise) {
    classifierPromise = FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
    ).then((vision) =>
      ImageClassifier.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL },
        maxResults: 5,
      })
    );
  }
  return classifierPromise;
}

export async function classifyOnDevice(image: HTMLImageElement) {
  const classifier = await getClassifier();
  const result = classifier.classify(image);
  return (result.classifications[0]?.categories ?? []).map((c) => ({
    label: c.categoryName ?? "",
    score: c.score,
  }));
}
