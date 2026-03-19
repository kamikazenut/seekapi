import { env, tmdbConfigured } from "./config";
import type { MediaGuess, MediaType, ResolvedMediaMatch, TmdbEpisodeRecord, TmdbTitleRecord } from "./types";

const TMDB_BASE_URL = "https://api.themoviedb.org/3";

interface SearchResult {
  id: number;
  title?: string;
  original_title?: string;
  name?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  popularity?: number;
}

interface SearchResponse {
  results: SearchResult[];
}

export interface TmdbCatalogMovie {
  tmdbId: number;
  title: string;
  originalTitle: string | null;
  releaseDate: string | null;
  adult: boolean;
  overview: string | null;
}

export interface TmdbCatalogShow {
  tmdbId: number;
  name: string;
  originalName: string | null;
  firstAirDate: string | null;
  adult: boolean;
  overview: string | null;
}

function normalizeTitle(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function getBigrams(input: string): string[] {
  const normalized = normalizeTitle(input).replace(/\s/g, "");
  if (normalized.length < 2) {
    return normalized ? [normalized] : [];
  }

  const output: string[] = [];
  for (let index = 0; index < normalized.length - 1; index += 1) {
    output.push(normalized.slice(index, index + 2));
  }

  return output;
}

function diceCoefficient(left: string, right: string): number {
  if (!left || !right) {
    return 0;
  }

  const leftBigrams = getBigrams(left);
  const rightBigrams = getBigrams(right);

  if (leftBigrams.length === 0 || rightBigrams.length === 0) {
    return normalizeTitle(left) === normalizeTitle(right) ? 1 : 0;
  }

  const counts = new Map<string, number>();
  for (const bigram of leftBigrams) {
    counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
  }

  let overlap = 0;
  for (const bigram of rightBigrams) {
    const count = counts.get(bigram) ?? 0;
    if (count > 0) {
      overlap += 1;
      counts.set(bigram, count - 1);
    }
  }

  return (2 * overlap) / (leftBigrams.length + rightBigrams.length);
}

function jaccardTokens(left: string, right: string): number {
  const leftTokens = new Set(normalizeTitle(left).split(" ").filter(Boolean));
  const rightTokens = new Set(normalizeTitle(right).split(" ").filter(Boolean));

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }

  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

function titleSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeTitle(left);
  const normalizedRight = normalizeTitle(right);

  if (!normalizedLeft || !normalizedRight) {
    return 0;
  }

  if (normalizedLeft === normalizedRight) {
    return 1;
  }

  const containsScore = normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft) ? 0.92 : 0;
  const blendedScore = (diceCoefficient(normalizedLeft, normalizedRight) + jaccardTokens(normalizedLeft, normalizedRight)) / 2;
  return Math.max(containsScore, blendedScore);
}

function getResultYear(result: SearchResult): number | undefined {
  const value = result.release_date ?? result.first_air_date;
  if (!value) {
    return undefined;
  }

  const year = Number(value.slice(0, 4));
  return Number.isNaN(year) ? undefined : year;
}

function scoreSearchResult(guess: MediaGuess, result: SearchResult): number {
  const titles = [result.title, result.original_title, result.name, result.original_name].filter(
    (value): value is string => Boolean(value)
  );

  const titleScore = Math.max(...titles.map((title) => titleSimilarity(guess.title, title)), 0);
  const resultYear = getResultYear(result);

  let yearScore = 0;
  if (guess.year && resultYear) {
    const distance = Math.abs(guess.year - resultYear);
    if (distance === 0) {
      yearScore = 0.18;
    } else if (distance === 1) {
      yearScore = 0.08;
    } else if (distance > 3) {
      yearScore = -0.08;
    }
  }

  const popularityScore = Math.min((result.popularity ?? 0) / 1000, 0.05);
  return titleScore + yearScore + popularityScore;
}

async function tmdbRequest<T>(pathname: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
  if (!tmdbConfigured) {
    throw new Error("TMDB credentials are not configured.");
  }

  const url = new URL(`${TMDB_BASE_URL}${pathname}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  if (env.TMDB_API_KEY) {
    url.searchParams.set("api_key", env.TMDB_API_KEY);
  }

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      ...(env.TMDB_READ_ACCESS_TOKEN ? { Authorization: `Bearer ${env.TMDB_READ_ACCESS_TOKEN}` } : {})
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`TMDB request failed (${response.status}): ${body}`);
  }

  return (await response.json()) as T;
}

function mapMovie(details: Record<string, unknown>): TmdbTitleRecord {
  return {
    mediaType: "movie",
    tmdbId: Number(details.id),
    title: String(details.title ?? ""),
    originalTitle: String(details.original_title ?? ""),
    releaseDate: typeof details.release_date === "string" ? details.release_date : null,
    posterPath: typeof details.poster_path === "string" ? details.poster_path : null,
    backdropPath: typeof details.backdrop_path === "string" ? details.backdrop_path : null,
    metadata: details
  };
}

function mapShow(details: Record<string, unknown>): TmdbTitleRecord {
  return {
    mediaType: "tv",
    tmdbId: Number(details.id),
    title: String(details.name ?? ""),
    originalTitle: String(details.original_name ?? ""),
    releaseDate: typeof details.first_air_date === "string" ? details.first_air_date : null,
    posterPath: typeof details.poster_path === "string" ? details.poster_path : null,
    backdropPath: typeof details.backdrop_path === "string" ? details.backdrop_path : null,
    metadata: details
  };
}

function mapEpisode(showTmdbId: number, seasonNumber: number, episodeNumber: number, details: Record<string, unknown>): TmdbEpisodeRecord {
  return {
    showTmdbId,
    seasonNumber,
    episodeNumber,
    name: typeof details.name === "string" ? details.name : null,
    airDate: typeof details.air_date === "string" ? details.air_date : null,
    metadata: details
  };
}

async function searchTmdb(type: MediaType, guess: MediaGuess): Promise<{ id: number; score: number } | null> {
  const endpoint = type === "movie" ? "/search/movie" : "/search/tv";
  let bestMatch: { id: number; score: number } | null = null;

  for (const searchTerm of guess.searchTerms) {
    const response = await tmdbRequest<SearchResponse>(endpoint, {
      query: searchTerm,
      ...(type === "movie" ? { year: guess.year } : { first_air_date_year: guess.year })
    });

    for (const result of response.results ?? []) {
      const score = scoreSearchResult(guess, result);
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { id: result.id, score };
      }
    }
  }

  return bestMatch && bestMatch.score >= 0.35 ? bestMatch : null;
}

export async function resolveMediaMatch(guess: MediaGuess): Promise<ResolvedMediaMatch | null> {
  if (!tmdbConfigured) {
    return null;
  }

  const bestMatch = await searchTmdb(guess.type, guess);
  if (!bestMatch) {
    return null;
  }

  if (guess.type === "movie") {
    const details = await tmdbRequest<Record<string, unknown>>(`/movie/${bestMatch.id}`);
    return {
      title: mapMovie(details),
      score: bestMatch.score
    };
  }

  const showDetails = await tmdbRequest<Record<string, unknown>>(`/tv/${bestMatch.id}`);
  let episode: TmdbEpisodeRecord | undefined;

  if (guess.seasonNumber !== undefined && guess.episodeNumber !== undefined) {
    try {
      const episodeDetails = await tmdbRequest<Record<string, unknown>>(
        `/tv/${bestMatch.id}/season/${guess.seasonNumber}/episode/${guess.episodeNumber}`
      );

      episode = mapEpisode(bestMatch.id, guess.seasonNumber, guess.episodeNumber, episodeDetails);
    } catch {
      episode = {
        showTmdbId: bestMatch.id,
        seasonNumber: guess.seasonNumber,
        episodeNumber: guess.episodeNumber,
        name: null,
        airDate: null,
        metadata: {}
      };
    }
  }

  return {
    title: mapShow(showDetails),
    episode,
    score: bestMatch.score
  };
}

export async function fetchTitleByTmdbId(mediaType: MediaType, tmdbId: number): Promise<TmdbTitleRecord | null> {
  if (!tmdbConfigured) {
    return null;
  }

  const pathname = mediaType === "movie" ? `/movie/${tmdbId}` : `/tv/${tmdbId}`;
  try {
    const details = await tmdbRequest<Record<string, unknown>>(pathname);
    return mediaType === "movie" ? mapMovie(details) : mapShow(details);
  } catch {
    return null;
  }
}

export async function fetchEpisodeByTmdbId(
  showTmdbId: number,
  seasonNumber: number,
  episodeNumber: number
): Promise<TmdbEpisodeRecord | null> {
  if (!tmdbConfigured) {
    return null;
  }

  try {
    const details = await tmdbRequest<Record<string, unknown>>(
      `/tv/${showTmdbId}/season/${seasonNumber}/episode/${episodeNumber}`
    );

    return mapEpisode(showTmdbId, seasonNumber, episodeNumber, details);
  } catch {
    return null;
  }
}

export async function fetchSeasonEpisodesByTmdbId(showTmdbId: number, seasonNumber: number): Promise<TmdbEpisodeRecord[]> {
  if (!tmdbConfigured) {
    return [];
  }

  try {
    const details = await tmdbRequest<Record<string, unknown>>(`/tv/${showTmdbId}/season/${seasonNumber}`);
    const episodes = Array.isArray(details.episodes) ? details.episodes : [];

    return episodes
      .map((episode) => {
        if (!episode || typeof episode !== "object") {
          return null;
        }

        const episodeNumber = typeof episode.episode_number === "number" ? episode.episode_number : null;
        if (!episodeNumber || episodeNumber <= 0) {
          return null;
        }

        return mapEpisode(showTmdbId, seasonNumber, episodeNumber, episode as Record<string, unknown>);
      })
      .filter((episode): episode is TmdbEpisodeRecord => Boolean(episode));
  } catch {
    return [];
  }
}

export async function fetchPopularMovies(page = 1): Promise<TmdbCatalogMovie[]> {
  if (!tmdbConfigured) {
    return [];
  }

  try {
    const response = await tmdbRequest<{
      results?: Array<Record<string, unknown>>;
    }>("/movie/popular", { page });

    return (response.results ?? [])
      .map((item) => {
        const tmdbId = typeof item.id === "number" ? item.id : null;
        if (!tmdbId) {
          return null;
        }

        return {
          tmdbId,
          title: typeof item.title === "string" ? item.title : `Movie ${tmdbId}`,
          originalTitle: typeof item.original_title === "string" ? item.original_title : null,
          releaseDate: typeof item.release_date === "string" ? item.release_date : null,
          adult: item.adult === true,
          overview: typeof item.overview === "string" ? item.overview : null
        };
      })
      .filter((item): item is TmdbCatalogMovie => Boolean(item));
  } catch {
    return [];
  }
}

export async function fetchPopularShows(page = 1): Promise<TmdbCatalogShow[]> {
  if (!tmdbConfigured) {
    return [];
  }

  try {
    const response = await tmdbRequest<{
      results?: Array<Record<string, unknown>>;
    }>("/tv/popular", { page });

    return (response.results ?? [])
      .map((item) => {
        const tmdbId = typeof item.id === "number" ? item.id : null;
        if (!tmdbId) {
          return null;
        }

        return {
          tmdbId,
          name: typeof item.name === "string" ? item.name : `TV ${tmdbId}`,
          originalName: typeof item.original_name === "string" ? item.original_name : null,
          firstAirDate: typeof item.first_air_date === "string" ? item.first_air_date : null,
          adult: item.adult === true,
          overview: typeof item.overview === "string" ? item.overview : null
        };
      })
      .filter((item): item is TmdbCatalogShow => Boolean(item));
  } catch {
    return [];
  }
}
