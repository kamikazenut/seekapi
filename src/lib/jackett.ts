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
  if (normalized === "2160p") {
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

  if (guess.type === "tv" && guess.seasonNumber === target.seasonNumber && guess.episodeNumber === target.episodeNumber) {
    score += 8;
  } else if (target.seasonNumber !== undefined && isSeasonPack(resultTitle, target.seasonNumber)) {
    score += 4;
  } else {
    score -= 6;
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
    params.set("season", String(target.seasonNumber));
    params.set("ep", String(target.episodeNumber));
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
    const episodeCode = `S${String(target.seasonNumber ?? 0).padStart(2, "0")}E${String(target.episodeNumber ?? 0).padStart(2, "0")}`;
    const seasonLabel = `Season ${target.seasonNumber ?? 0}`;

    for (const titleVariant of titleVariants) {
      addAttempt(`tv tmdb ${titleVariant}`, titleVariant, "tvsearch", { tmdbid: target.tmdbId });
      addAttempt(`tv title ${titleVariant}`, titleVariant, "tvsearch");
      addAttempt(`tv text ${titleVariant} ${episodeCode}`, `${titleVariant} ${episodeCode}`, "search");
      addAttempt(`tv text ${titleVariant} ${seasonLabel}`, `${titleVariant} ${seasonLabel}`, "search");
      if (episode?.name) {
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
    .filter((item) => !isAdultCategory(item.categories))
    .filter((item) => !containsAdultTerms(item.title))
    .sort((left, right) => right.score - left.score);
}
