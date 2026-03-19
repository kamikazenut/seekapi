import { XMLParser } from "fast-xml-parser";

import { env } from "./config";
import { containsAdultTerms, isAdultCategory } from "./content-safety";
import { extractMediaGuess } from "./media-parser";
import type { AutomationTarget, CachedEpisodeRow, CachedTitleRow } from "./types";

export interface JackettSearchResult {
  title: string;
  guid: string;
  downloadUrl: string | null;
  magnetUrl: string | null;
  detailsUrl: string | null;
  size: number | null;
  seeders: number | null;
  peers: number | null;
  publishDate: string | null;
  resolution: string | null;
  categories: number[];
  score: number;
  raw: Record<string, unknown>;
}

interface JackettSearchAttempt {
  label: string;
  params: URLSearchParams;
}

class JackettRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(`Jackett request failed (${status}): ${body}`);
  }
}

const parser = new XMLParser({
  attributeNamePrefix: "",
  ignoreAttributes: false,
  removeNSPrefix: true,
  trimValues: true
});

const BYTES_PER_GIB = 1024 ** 3;

function ensureJackettConfigured(): void {
  if (!env.JACKETT_BASE_URL || !env.JACKETT_API_KEY) {
    throw new Error("Jackett is not configured.");
  }
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function normalizeTitle(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean))];
}

function tokenizeTitle(input: string): string[] {
  return normalizeTitle(input).split(" ").filter(Boolean);
}

function containsNormalizedPhrase(haystack: string, needle: string): boolean {
  const normalizedHaystack = normalizeTitle(haystack);
  const normalizedNeedle = normalizeTitle(needle);
  if (!normalizedHaystack || !normalizedNeedle) {
    return false;
  }

  const escaped = normalizedNeedle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^| )${escaped}(?:$| )`, "i");
  return pattern.test(normalizedHaystack);
}

function overlapScore(left: string, right: string): number {
  const leftTokens = new Set(normalizeTitle(left).split(" ").filter(Boolean));
  const rightTokens = new Set(normalizeTitle(right).split(" ").filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function getAttrMap(item: Record<string, unknown>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const attr of toArray(item.attr as Record<string, unknown> | Array<Record<string, unknown>> | undefined)) {
    const name = typeof attr.name === "string" ? attr.name.toLowerCase() : null;
    const value = attr.value;
    if (name && (typeof value === "string" || typeof value === "number")) {
      output[name] = String(value);
    }
  }

  return output;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function readCategories(item: Record<string, unknown>): number[] {
  const categories = toArray(item.category as unknown[] | unknown)
    .map((value) => readNumber(value))
    .filter((value): value is number => value !== null);

  return [...new Set(categories)];
}

function resolutionRank(value: string | null): number {
  const normalized = value?.toLowerCase();
  if (normalized === "4320p") {
    return 6;
  }

  if (normalized === "2160p") {
    return 5;
  }

  if (normalized === "1440p") {
    return 4;
  }

  if (normalized === "1080p") {
    return 3;
  }

  if (normalized === "720p") {
    return 2;
  }

  if (normalized === "480p") {
    return 1;
  }

  return 0;
}

function isSeasonPack(title: string, seasonNumber: number): boolean {
  const seasonPattern = new RegExp(`\\bS0?${seasonNumber}\\b`, "i");
  const wordPattern = new RegExp(`\\bSeason[ ._-]*0?${seasonNumber}\\b`, "i");
  return seasonPattern.test(title) || wordPattern.test(title);
}

function extractMentionedSeasonNumbers(title: string): number[] {
  const values = new Set<number>();

  for (const match of title.matchAll(/\bS(\d{1,2})(?!E\d)\b/gi)) {
    const seasonNumber = Number(match[1]);
    if (Number.isInteger(seasonNumber) && seasonNumber > 0) {
      values.add(seasonNumber);
    }
  }

  for (const match of title.matchAll(/\bSeason[ ._-]*(\d{1,2})\b/gi)) {
    const seasonNumber = Number(match[1]);
    if (Number.isInteger(seasonNumber) && seasonNumber > 0) {
      values.add(seasonNumber);
    }
  }

  return [...values].sort((left, right) => left - right);
}

function isMultiSeasonCollectionRelease(title: string, seasonNumber: number): boolean {
  const seriesPatterns = [
    /\bcomplete[ ._-]+series\b/i,
    /\bcomplete[ ._-]+sagas?\b/i,
    /\bcomplete[ ._-]+box[ ._-]*set\b/i,
    /\bseries[ ._-]+pack\b/i,
    /\ball[ ._-]+seasons?\b/i
  ];

  if (seriesPatterns.some((pattern) => pattern.test(title))) {
    return true;
  }

  const seasonRangePatterns = [
    /\bseasons?\s*\d{1,2}\s*(?:-|to|thru|through|&|and)\s*\d{1,2}\b/i,
    /\bS\d{1,2}\s*(?:-|to|thru|through|&|and)\s*S?\d{1,2}\b/i
  ];

  if (seasonRangePatterns.some((pattern) => pattern.test(title))) {
    return true;
  }

  const mentionedSeasons = extractMentionedSeasonNumbers(title);
  return mentionedSeasons.some((value) => value !== seasonNumber);
}

function isSingleEpisodeRelease(title: string, seasonNumber: number): boolean {
  const exactEpisodePattern = new RegExp(`\\bS0?${seasonNumber}E\\d{1,3}\\b`, "i");
  const rangedEpisodePattern = new RegExp(`\\bS0?${seasonNumber}E\\d{1,3}\\s*(?:-|to|thru|through)\\s*E?\\d{1,3}\\b`, "i");
  const multiEpisodePattern = new RegExp(`\\bS0?${seasonNumber}E\\d{1,3}(?:[ ._\\-]+E\\d{1,3})+\\b`, "i");

  if (rangedEpisodePattern.test(title) || multiEpisodePattern.test(title)) {
    return false;
  }

  return exactEpisodePattern.test(title);
}

function isSeasonCollectionRelease(title: string, seasonNumber: number): boolean {
  if (isMultiSeasonCollectionRelease(title, seasonNumber)) {
    return false;
  }

  const completeSeasonPattern = new RegExp(`\\b(?:Complete|Full)[ ._-]*(?:Season[ ._-]*)?0?${seasonNumber}\\b`, "i");
  const seasonCompletePattern = new RegExp(`\\b(?:Season[ ._-]*)?0?${seasonNumber}[ ._-]*(?:Complete|Pack|Collection)\\b`, "i");
  const seasonRangePattern = new RegExp(`\\bS0?${seasonNumber}E\\d{1,3}\\s*(?:-|to|thru|through)\\s*E?\\d{1,3}\\b`, "i");
  const multiEpisodePattern = new RegExp(`\\bS0?${seasonNumber}E\\d{1,3}(?:[ ._\\-]+E\\d{1,3})+\\b`, "i");

  if (completeSeasonPattern.test(title) || seasonCompletePattern.test(title) || seasonRangePattern.test(title) || multiEpisodePattern.test(title)) {
    return true;
  }

  return isSeasonPack(title, seasonNumber) && !isSingleEpisodeRelease(title, seasonNumber);
}

function extractYearFromTitle(input: string): number | null {
  const match = input.match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function bestTitleSimilarity(title: CachedTitleRow, resultTitle: string): number {
  return Math.max(...unique([title.title, title.original_title]).map((value) => overlapScore(value, resultTitle)), 0);
}

function passesAvailabilityGate(result: JackettSearchResult): boolean {
  const seedersOk = result.seeders !== null ? result.seeders > env.JACKETT_MIN_SEEDERS : false;
  const peersOk = result.peers !== null ? result.peers > env.JACKETT_MIN_PEERS : false;

  if (result.seeders === null && result.peers === null) {
    return false;
  }

  return seedersOk || peersOk;
}

function passesSizeGate(result: JackettSearchResult): boolean {
  if (result.size === null) {
    return false;
  }

  return result.size <= env.JACKETT_MAX_SIZE_GB * BYTES_PER_GIB;
}

function passesResolutionGate(result: JackettSearchResult): boolean {
  if (!result.resolution) {
    return false;
  }

  return resolutionRank(result.resolution) <= resolutionRank(env.JACKETT_MAX_RESOLUTION);
}

function passesTitleGate(
  target: AutomationTarget,
  title: CachedTitleRow,
  resultTitle: string,
  episode: CachedEpisodeRow | null
): boolean {
  const titleVariants = unique([title.title, title.original_title]);
  const tokenCounts = titleVariants.map((value) => tokenizeTitle(value).length).filter((value) => value > 0);
  const shortestTokenCount = tokenCounts.length > 0 ? Math.min(...tokenCounts) : 0;
  const minSimilarity = shortestTokenCount <= 2 ? 0.95 : shortestTokenCount === 3 ? 0.82 : 0.68;
  const similarity = bestTitleSimilarity(title, resultTitle);
  const phraseMatched = titleVariants.some((value) => containsNormalizedPhrase(resultTitle, value));
  const startsWithTitle = titleVariants.some((value) => normalizeTitle(resultTitle).startsWith(normalizeTitle(value)));

  if (!(startsWithTitle || phraseMatched || similarity >= minSimilarity)) {
    return false;
  }

  const guessed = extractMediaGuess(resultTitle, resultTitle);

  if (target.mediaType === "movie") {
    if (guessed.type === "tv") {
      return false;
    }

    const releaseYear = title.release_date ? Number(title.release_date.slice(0, 4)) : null;
    const resultYear = extractYearFromTitle(resultTitle);
    if (releaseYear && resultYear && Math.abs(releaseYear - resultYear) > 1) {
      return false;
    }

    return true;
  }

  if (target.seasonNumber === undefined) {
    return false;
  }

  const seasonPack = isSeasonPack(resultTitle, target.seasonNumber);
  if (target.episodeNumber === undefined) {
    if (guessed.type === "tv" && guessed.seasonNumber !== undefined && guessed.seasonNumber !== target.seasonNumber) {
      return false;
    }

    return isSeasonCollectionRelease(resultTitle, target.seasonNumber);
  }

  if (guessed.type === "tv" && guessed.seasonNumber !== undefined && guessed.seasonNumber !== target.seasonNumber) {
    return false;
  }

  if (guessed.type === "tv" && guessed.episodeNumber !== undefined) {
    return guessed.episodeNumber === target.episodeNumber;
  }

  if (seasonPack) {
    return true;
  }

  if (episode?.name && containsNormalizedPhrase(resultTitle, episode.name)) {
    return true;
  }

  return false;
}

function scoreResult(
  target: AutomationTarget,
  title: CachedTitleRow,
  episode: CachedEpisodeRow | null,
  resultTitle: string,
  resolution: string | null,
  seeders: number | null,
  hasDownloadUrl: boolean
): number {
  const titleVariants = unique([title.title, title.original_title]);
  const titleScore = Math.max(...titleVariants.map((value) => overlapScore(value, resultTitle)), 0);

  let score = titleScore * 10;
  score += resolutionRank(resolution) * 1.5;
  score += Math.min((seeders ?? 0) / 50, 3);

  if (hasDownloadUrl) {
    score += 1.5;
  }

  if (target.mediaType === "movie") {
    return score;
  }

  const guess = extractMediaGuess(resultTitle, resultTitle);

  if (target.episodeNumber !== undefined) {
    if (guess.type === "tv" && guess.seasonNumber === target.seasonNumber && guess.episodeNumber === target.episodeNumber) {
      score += 8;
    } else if (target.seasonNumber !== undefined && isSeasonPack(resultTitle, target.seasonNumber)) {
      score += 4;
    } else {
      score -= 6;
    }
  } else {
    if (target.seasonNumber !== undefined && isSeasonCollectionRelease(resultTitle, target.seasonNumber)) {
      score += 10;
    }

    if (guess.type === "tv" && guess.seasonNumber === target.seasonNumber && guess.episodeNumber !== undefined) {
      score -= 8;
    } else if (guess.type === "tv" && guess.seasonNumber !== undefined && guess.seasonNumber !== target.seasonNumber) {
      score -= 6;
    }
  }

  if (episode?.name) {
    score += overlapScore(episode.name, resultTitle) * 2;
  }

  return score;
}

function mapResult(
  item: Record<string, unknown>,
  target: AutomationTarget,
  title: CachedTitleRow,
  episode: CachedEpisodeRow | null
): JackettSearchResult {
  const attrs = getAttrMap(item);
  const magnetUrl = typeof attrs.magneturl === "string" ? attrs.magneturl : null;
  const enclosure = toArray(item.enclosure as Record<string, unknown> | Array<Record<string, unknown>> | undefined)[0];
  const downloadUrl =
    magnetUrl ||
    (typeof enclosure?.url === "string" && enclosure.url) ||
    (typeof item.link === "string" ? item.link : null);
  const detailsUrl = typeof item.comments === "string" ? item.comments : typeof item.guid === "string" ? item.guid : null;
  const resultTitle = typeof item.title === "string" ? item.title : "Untitled release";
  const resolution = extractMediaGuess(resultTitle, resultTitle).resolution ?? null;
  const categories = readCategories(item);

  return {
    title: resultTitle,
    guid: typeof item.guid === "string" ? item.guid : resultTitle,
    downloadUrl,
    magnetUrl,
    detailsUrl,
    size: readNumber(attrs.size ?? item.size),
    seeders: readNumber(attrs.seeders),
    peers: readNumber(attrs.peers),
    publishDate: typeof item.pubDate === "string" ? item.pubDate : null,
    resolution,
    categories,
    score: scoreResult(target, title, episode, resultTitle, resolution, readNumber(attrs.seeders), Boolean(downloadUrl)),
    raw: item
  };
}

function buildBaseParams(target: AutomationTarget, title: CachedTitleRow): URLSearchParams {
  const params = new URLSearchParams({
    apikey: env.JACKETT_API_KEY!,
    cat: target.mediaType === "movie" ? "2000" : "5000"
  });

  if (target.mediaType === "movie") {
    const year = title.release_date?.slice(0, 4);
    if (year) {
      params.set("year", year);
    }
  } else {
    if (target.seasonNumber !== undefined) {
      params.set("season", String(target.seasonNumber));
    }
    if (target.episodeNumber !== undefined) {
      params.set("ep", String(target.episodeNumber));
    }
  }

  return params;
}

function buildSearchAttempts(
  target: AutomationTarget,
  title: CachedTitleRow,
  episode: CachedEpisodeRow | null
): JackettSearchAttempt[] {
  const baseParams = buildBaseParams(target, title);
  const titleVariants = unique([title.title, title.original_title]);
  const attempts: JackettSearchAttempt[] = [];

  const addAttempt = (label: string, query: string, mode: string, extra: Record<string, string | number | undefined> = {}) => {
    if (!query.trim()) {
      return;
    }

    const params = new URLSearchParams(baseParams);
    params.set("t", mode);
    params.set("q", query.trim());

    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined && value !== null && value !== "") {
        params.set(key, String(value));
      }
    }

    attempts.push({ label, params });
  };

  if (target.mediaType === "movie") {
    for (const titleVariant of titleVariants) {
      addAttempt(`movie tmdb ${titleVariant}`, titleVariant, "movie", { tmdbid: target.tmdbId });
      addAttempt(`movie title ${titleVariant}`, titleVariant, "movie");
      addAttempt(`movie text ${titleVariant}`, `${titleVariant} ${title.release_date?.slice(0, 4) ?? ""}`.trim(), "search");
    }
  } else {
    const seasonCode = `S${String(target.seasonNumber ?? 0).padStart(2, "0")}`;
    const episodeCode = `${seasonCode}E${String(target.episodeNumber ?? 0).padStart(2, "0")}`;
    const seasonLabel = `Season ${target.seasonNumber ?? 0}`;

    for (const titleVariant of titleVariants) {
      addAttempt(`tv tmdb ${titleVariant}`, titleVariant, "tvsearch", { tmdbid: target.tmdbId });
      addAttempt(`tv title ${titleVariant}`, titleVariant, "tvsearch");
      addAttempt(`tv text ${titleVariant} ${seasonLabel}`, `${titleVariant} ${seasonLabel}`, "search");
      addAttempt(`tv text ${titleVariant} ${seasonCode}`, `${titleVariant} ${seasonCode}`, "search");
      if (target.episodeNumber === undefined) {
        addAttempt(`tv text ${titleVariant} complete ${seasonLabel}`, `${titleVariant} complete ${seasonLabel}`, "search");
        addAttempt(`tv text ${titleVariant} complete ${seasonCode}`, `${titleVariant} complete ${seasonCode}`, "search");
        addAttempt(`tv text ${titleVariant} ${seasonLabel} pack`, `${titleVariant} ${seasonLabel} pack`, "search");
      }
      if (target.episodeNumber !== undefined) {
        addAttempt(`tv text ${titleVariant} ${episodeCode}`, `${titleVariant} ${episodeCode}`, "search");
      }
      if (episode?.name && target.episodeNumber !== undefined) {
        addAttempt(`tv text ${titleVariant} ${episode.name}`, `${titleVariant} ${episode.name}`, "search");
      }
    }
  }

  const seen = new Set<string>();
  return attempts.filter((attempt) => {
    const key = attempt.params.toString();
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function parseItems(xml: string): Record<string, unknown>[] {
  const payload = parser.parse(xml) as {
    rss?: {
      channel?: {
        item?: Record<string, unknown> | Array<Record<string, unknown>>;
      };
    };
  };

  return toArray(payload.rss?.channel?.item);
}

async function requestJackett(params: URLSearchParams): Promise<Record<string, unknown>[]> {
  ensureJackettConfigured();

  const baseUrl = env.JACKETT_BASE_URL!.replace(/\/+$/, "");
  const requestUrl = `${baseUrl}/api/v2.0/indexers/${encodeURIComponent(env.JACKETT_INDEXER)}/results/torznab/api?${params.toString()}`;
  const response = await fetch(requestUrl, {
    headers: {
      Accept: "application/xml,text/xml"
    }
  });

  const body = await response.text();
  if (!response.ok) {
    throw new JackettRequestError(response.status, body);
  }

  return parseItems(body);
}

export async function searchJackett(
  target: AutomationTarget,
  title: CachedTitleRow,
  episode: CachedEpisodeRow | null
): Promise<JackettSearchResult[]> {
  ensureJackettConfigured();
  const attempts = buildSearchAttempts(target, title, episode);
  const items: Record<string, unknown>[] = [];
  let lastHardError: JackettRequestError | null = null;
  let hadSuccessfulAttempt = false;

  for (const attempt of attempts) {
    try {
      items.push(...(await requestJackett(attempt.params)));
      hadSuccessfulAttempt = true;
      if (items.length > 0) {
        break;
      }
    } catch (error) {
      if (error instanceof JackettRequestError && error.status === 400) {
        lastHardError = error;
        continue;
      }

      throw error;
    }
  }

  if (items.length === 0 && !hadSuccessfulAttempt && lastHardError) {
    throw lastHardError;
  }

  return items
    .map((item) => mapResult(item, target, title, episode))
    .filter((item) => item.downloadUrl)
    .filter((item) => passesSizeGate(item))
    .filter((item) => passesResolutionGate(item))
    .filter((item) => passesAvailabilityGate(item))
    .filter((item) => !isAdultCategory(item.categories))
    .filter((item) => !containsAdultTerms(item.title))
    .filter((item) => passesTitleGate(target, title, item.title, episode))
    .sort((left, right) => right.score - left.score);
}
