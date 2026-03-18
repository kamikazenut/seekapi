import { env } from "./config";

const DEFAULT_ADULT_TERMS = [
  "xxx",
  "porn",
  "porno",
  "pornhub",
  "xvideos",
  "xnxx",
  "xhamster",
  "redtube",
  "youporn",
  "sex tape",
  "sex video",
  "erotic",
  "erotica",
  "nsfw",
  "camgirl",
  "camgirls",
  "camsoda",
  "chaturbate",
  "livejasmin",
  "brazzers",
  "fake taxi",
  "bangbros",
  "onlyfans",
  "fansly",
  "naughty america",
  "evil angel",
  "blacked",
  "blacked raw",
  "tushy",
  "deeper",
  "mofos",
  "reality kings",
  "team skeet",
  "digital playground",
  "vixen",
  "milf",
  "stepmom",
  "stepsis",
  "blowjob",
  "threesome",
  "jav uncensored",
  "hentai"
];

function normalizeText(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function configuredTerms(): string[] {
  const extraTerms = (env.ADULT_BLOCKLIST ?? "")
    .split(",")
    .map((term) => normalizeText(term))
    .filter(Boolean);

  return [...new Set([...DEFAULT_ADULT_TERMS.map(normalizeText), ...extraTerms])];
}

export function containsAdultTerms(...inputs: Array<string | null | undefined>): boolean {
  if (!env.ADULT_FILTER_ENABLED) {
    return false;
  }

  const haystack = normalizeText(inputs.filter((value): value is string => Boolean(value)).join(" "));
  if (!haystack) {
    return false;
  }

  return configuredTerms().some((term) => haystack.includes(term));
}

export function isAdultTmdbMetadata(metadata: Record<string, unknown> | null | undefined): boolean {
  if (!env.ADULT_FILTER_ENABLED || !metadata) {
    return false;
  }

  if (metadata.adult === true) {
    return true;
  }

  const genres = Array.isArray(metadata.genres) ? metadata.genres : [];
  const genreText = genres
    .map((genre) => {
      if (genre && typeof genre === "object" && "name" in genre && typeof genre.name === "string") {
        return genre.name;
      }

      return "";
    })
    .join(" ");

  return containsAdultTerms(
    typeof metadata.title === "string" ? metadata.title : null,
    typeof metadata.name === "string" ? metadata.name : null,
    typeof metadata.original_title === "string" ? metadata.original_title : null,
    typeof metadata.original_name === "string" ? metadata.original_name : null,
    typeof metadata.overview === "string" ? metadata.overview : null,
    genreText
  );
}

export function isAdultCategory(categories: number[]): boolean {
  if (!env.ADULT_FILTER_ENABLED) {
    return false;
  }

  return categories.some((category) => Math.floor(category / 1000) === 6);
}
