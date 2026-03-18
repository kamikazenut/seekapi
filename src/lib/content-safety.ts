import { env } from "./config";

const ADULT_STUDIO_TERMS = [
  "21 sextury",
  "adult time",
  "babes",
  "bangbros",
  "beeg",
  "blacked",
  "blacked raw",
  "brazzers",
  "burning angel",
  "cam4",
  "camsoda",
  "casting couch",
  "chaturbate",
  "clip4sale",
  "clips4sale",
  "devils film",
  "digital playground",
  "dogfart",
  "dorcel",
  "evil angel",
  "fake agent",
  "fake driving school",
  "fake hostel",
  "fakehub",
  "fake taxi",
  "familystrokes",
  "family strokes",
  "fakings",
  "fansly",
  "freeones",
  "girlsway",
  "girlfriend films",
  "hentai haven",
  "hussiepass",
  "imlive",
  "jerkmate",
  "julesjordan",
  "kink com",
  "kinkmen",
  "letsdoeit",
  "little caprice",
  "livejasmin",
  "metart",
  "mofos",
  "moms bang teens",
  "my dirty hobby",
  "myfreecams",
  "mylf",
  "manyvids",
  "modelhub",
  "naughty america",
  "nubiles",
  "onlyfans",
  "penthouse gold",
  "pervcity",
  "pornhub",
  "private com",
  "public agent",
  "public pickup",
  "reality junkies",
  "reality kings",
  "redtube",
  "scoreland",
  "sexmex",
  "sexart",
  "spankbang",
  "stripchat",
  "team skeet",
  "tube8",
  "tnaflix",
  "tushy",
  "twistys",
  "vixen",
  "wicked pictures",
  "xconfessions",
  "xart",
  "xhamster",
  "xnxx",
  "xvideos",
  "youjizz",
  "youporn"
];

const ADULT_CONTENT_TERMS = [
  "18 plus",
  "18plus",
  "adult entertainment",
  "adult film",
  "adult movie",
  "adult video",
  "amateur sex",
  "anal",
  "anal sex",
  "anime porn",
  "ass worship",
  "ass fucking",
  "bareback sex",
  "bdsm porn",
  "big tits",
  "big black cock",
  "boobjob",
  "blowbang",
  "blowjob",
  "breeding porn",
  "bukkake",
  "cam porn",
  "camgirl",
  "camgirls",
  "camshow",
  "cock worship",
  "college sex",
  "creampie",
  "cumshot",
  "deep throat",
  "deepthroat",
  "dick sucking",
  "dildo fucking",
  "double penetration",
  "doujin hentai",
  "ecchi hentai",
  "erotic movie",
  "erotic sex",
  "erotic porn",
  "escort porn",
  "escort sex",
  "explicit sex",
  "facefuck",
  "facial cumshot",
  "fellatio",
  "fetish porn",
  "femdom porn",
  "fisting",
  "footjob",
  "foursome sex",
  "fuck fest",
  "fucked hard",
  "futanari",
  "gangbang",
  "gay porn",
  "girl girl porn",
  "gloryhole",
  "glory hole",
  "gonzo porn",
  "handjob",
  "hardcore sex",
  "hentai",
  "home porn",
  "incest sex",
  "incest porn",
  "interracial porn",
  "jav uncensored",
  "jerk off instruction",
  "lesbian porn",
  "live sex",
  "loli hentai",
  "masturbation porn",
  "massage porn",
  "mature porn",
  "milf porn",
  "nsfw",
  "nude cam",
  "nude sexvideo",
  "orgy",
  "pegging",
  "porn",
  "porn movie",
  "porn scene",
  "porno",
  "pornstar",
  "pov sex",
  "public sex",
  "pussy licking",
  "r 18",
  "r18",
  "rough sex",
  "rule 34",
  "rule34",
  "rimming",
  "sex cam",
  "sex tape",
  "sex video",
  "sexcam",
  "shota hentai",
  "squirting",
  "strip club sex",
  "striptease porn",
  "swingers porn",
  "swinger sex",
  "teen sex",
  "teen porn",
  "threesome",
  "titfuck",
  "trans porn",
  "tranny porn",
  "uncensored sex",
  "vr porn",
  "voyeur porn",
  "webcam sex",
  "webcam porn",
  "wet pussy",
  "wife swap sex",
  "x rated",
  "xrated",
  "xxx"
  ,"xxx movie"
  ,"xxx parody"
  ,"xxx video"
  ,"yiff"
];

function normalizeText(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function configuredTerms(): string[] {
  const extraTerms = (env.ADULT_BLOCKLIST ?? "")
    .split(",")
    .map((term) => normalizeText(term))
    .filter(Boolean);

  return [...new Set([...ADULT_STUDIO_TERMS, ...ADULT_CONTENT_TERMS, ...extraTerms].map(normalizeText).filter(Boolean))];
}

function containsPhrase(haystack: string, phrase: string): boolean {
  if (!haystack || !phrase) {
    return false;
  }

  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^| )${escaped}(?:$| )`, "i");
  return pattern.test(haystack);
}

export function containsAdultTerms(...inputs: Array<string | null | undefined>): boolean {
  if (!env.ADULT_FILTER_ENABLED) {
    return false;
  }

  const haystack = normalizeText(inputs.filter((value): value is string => Boolean(value)).join(" "));
  if (!haystack) {
    return false;
  }

  return configuredTerms().some((term) => containsPhrase(haystack, term));
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
