import type { Prediction } from "./hfClassify";

// below this the model is basically guessing, so we don't pretend to know the breed
const LOW_CONFIDENCE = 0.15;
// if the top two guesses are this close, it's more honest to mention both
const CLOSE_MARGIN = 0.1;

// empty string is in here on purpose, so not every line gets an opener
const OPENERS = [
  "",
  "Breaking news: ",
  "Scientific fact: ",
  "Plot twist: ",
  "For the record: ",
  "Official statement: ",
];

const PUNCHLINES = [
  "but honestly all I'm thinking about is snacks",
  "and I would like a treat immediately",
  "and I'm judging you a little bit right now",
  "but my brain is 90% squirrels at this point",
  "and I regret absolutely nothing",
  "and I am, in fact, a very good boy",
];

function pick<T>(options: readonly T[]): T {
  return options[Math.floor(Math.random() * options.length)];
}

// letter-based a/an guessing breaks on a handful of common words
// (a university, an hour), so these are called out by hand
function article(word: string) {
  const w = word.toLowerCase();
  if (/^(one|uni|eu|use|user|usual|utensil|utility)/.test(w)) return "a";
  if (/^(hour|honest|honor|honou?r|heir)/.test(w)) return "an";
  return /^[aeiou]/.test(w) ? "an" : "a";
}

function cleanLabel(label: string) {
  return label.split(",")[0].trim();
}

export function breedName(predictions: Prediction[]) {
  const [first] = predictions;
  return first && first.score >= LOW_CONFIDENCE ? cleanLabel(first.label) : null;
}

export function toDogLine(predictions: Prediction[]) {
  const opener = pick(OPENERS);
  const punchline = pick(PUNCHLINES);
  const [first, second] = predictions;

  if (!first || first.score < LOW_CONFIDENCE) {
    return `${opener}Honestly not sure what breed I am, ${punchline}.`;
  }

  const name1 = cleanLabel(first.label);

  if (second && first.score - second.score < CLOSE_MARGIN) {
    const name2 = cleanLabel(second.label);
    return `${opener}I might be ${article(name1)} ${name1}, might be ${article(name2)} ${name2}, hard to say, ${punchline}.`;
  }

  return `${opener}I am ${article(name1)} ${name1}, ${punchline}.`;
}
