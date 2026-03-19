import { automationConfigured, env, tmdbConfigured } from "./config";
import { queueAutomationTarget, queueSeasonAutomationTarget } from "./automation";
import { containsAdultTerms, isAdultTmdbMetadata } from "./content-safety";
import {
  getAutomationModeSettings,
  getLatestSeasonAutoGrabberShowTmdbId,
  getLatestAutomationJobForTarget,
  listMovieSources,
  listSeasonSources
} from "./repository";
import { fetchPopularMovies, fetchPopularShows, fetchSeasonEpisodesByTmdbId, fetchTitleByTmdbId } from "./tmdb";
import type { AutoGrabberStatus, AutomationTarget, TmdbTitleRecord } from "./types";

let intervalHandle: NodeJS.Timeout | null = null;
let running = false;
let lastStartedAt: string | null = null;
let lastFinishedAt: string | null = null;
let lastQueuedMovies = 0;
let lastQueuedSeasonPacks = 0;
let lastError: string | null = null;
let inflightCycle: Promise<AutoGrabberStatus> | null = null;
let seasonFollowUpHandle: NodeJS.Timeout | null = null;
let seasonShowLockTmdbId: number | null = null;

interface SeasonAutoGrabberCandidate {
  tmdbId: number;
  title: TmdbTitleRecord;
  unresolvedSeasonNumbers: number[];
}

function hasReleased(releaseDate: string | null | undefined): boolean {
  if (!releaseDate) {
    return false;
  }

  return new Date(releaseDate).getTime() <= Date.now();
}

function isRecentlyAttempted(updatedAt: string): boolean {
  return Date.now() - new Date(updatedAt).getTime() < env.AUTO_GRAB_REQUEUE_HOURS * 60 * 60 * 1000;
}

function clearSeasonFollowUpTimer(): void {
  if (!seasonFollowUpHandle) {
    return;
  }

  clearTimeout(seasonFollowUpHandle);
  seasonFollowUpHandle = null;
}

function scheduleSeasonFollowUpCycle(delayMs: number): void {
  if (delayMs <= 0 || !automationConfigured || !tmdbConfigured || seasonFollowUpHandle) {
    return;
  }

  seasonFollowUpHandle = setTimeout(() => {
    seasonFollowUpHandle = null;
    void triggerAutoGrabberCycle();
  }, delayMs);
}

async function shouldSkipTarget(target: AutomationTarget): Promise<boolean> {
  const latestJob = await getLatestAutomationJobForTarget(target);
  if (!latestJob) {
    return false;
  }

  if (latestJob.status === "completed" || latestJob.status === "failed") {
    return isRecentlyAttempted(latestJob.updated_at);
  }

  return true;
}

function listRegularSeasonNumbers(title: TmdbTitleRecord): number[] {
  const seasons = Array.isArray(title.metadata.seasons) ? title.metadata.seasons : [];
  return seasons
    .map((season) => {
      if (!season || typeof season !== "object") {
        return null;
      }

      const seasonNumber = typeof season.season_number === "number" ? season.season_number : null;
      const episodeCount = typeof season.episode_count === "number" ? season.episode_count : null;
      const airDate = typeof season.air_date === "string" ? season.air_date : null;

      if (!seasonNumber || seasonNumber <= 0 || !episodeCount || episodeCount <= 0) {
        return null;
      }

      if (airDate && !hasReleased(airDate)) {
        return null;
      }

      return seasonNumber;
    })
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);
}

async function listUnresolvedSeasonNumbers(showTmdbId: number, title: TmdbTitleRecord): Promise<number[]> {
  const seasonNumbers = listRegularSeasonNumbers(title);
  const unresolvedSeasonNumbers: number[] = [];

  for (const seasonNumber of seasonNumbers) {
    const episodes = await fetchSeasonEpisodesByTmdbId(showTmdbId, seasonNumber);
    if (episodes.length === 0) {
      continue;
    }

    const resolvedEpisodes = new Set(
      (await listSeasonSources(showTmdbId, seasonNumber))
        .map((source) => source.episode_number)
        .filter((episodeNumber): episodeNumber is number => episodeNumber !== null)
    );

    if (resolvedEpisodes.size >= episodes.length) {
      continue;
    }

    unresolvedSeasonNumbers.push(seasonNumber);
  }

  return unresolvedSeasonNumbers;
}

async function buildSeasonAutoGrabberCandidate(showTmdbId: number): Promise<SeasonAutoGrabberCandidate | null> {
  const title = await fetchTitleByTmdbId("tv", showTmdbId);
  if (!title || isAdultTmdbMetadata(title.metadata) || containsAdultTerms(title.title, title.originalTitle)) {
    return null;
  }

  const unresolvedSeasonNumbers = await listUnresolvedSeasonNumbers(showTmdbId, title);
  if (unresolvedSeasonNumbers.length === 0) {
    return null;
  }

  return {
    tmdbId: showTmdbId,
    title,
    unresolvedSeasonNumbers
  };
}

async function pickLockedSeasonAutoGrabberCandidate(): Promise<SeasonAutoGrabberCandidate | null> {
  const candidateTmdbIds = new Set<number>();
  if (seasonShowLockTmdbId) {
    candidateTmdbIds.add(seasonShowLockTmdbId);
  }

  const recentTmdbId = await getLatestSeasonAutoGrabberShowTmdbId();
  if (recentTmdbId) {
    candidateTmdbIds.add(recentTmdbId);
  }

  for (const tmdbId of candidateTmdbIds) {
    const candidate = await buildSeasonAutoGrabberCandidate(tmdbId);
    if (candidate) {
      seasonShowLockTmdbId = tmdbId;
      return candidate;
    }
  }

  seasonShowLockTmdbId = null;
  return null;
}

async function queueNextSeasonForShow(candidate: SeasonAutoGrabberCandidate): Promise<number> {
  for (let index = 0; index < candidate.unresolvedSeasonNumbers.length; index += 1) {
    const seasonNumber = candidate.unresolvedSeasonNumbers[index];
    const target: AutomationTarget = {
      mediaType: "tv",
      tmdbId: candidate.tmdbId,
      seasonNumber
    };

    if (await shouldSkipTarget(target)) {
      continue;
    }

    const job = await queueSeasonAutomationTarget(candidate.tmdbId, seasonNumber, "auto-grabber-season-pack", {
      metadata: {
        autoGrabberShowTitle: candidate.title.title,
        autoGrabberSeasonOrder: seasonNumber
      }
    });

    if (!job) {
      return 0;
    }

    if (candidate.unresolvedSeasonNumbers.slice(index + 1).length > 0) {
      scheduleSeasonFollowUpCycle(env.AUTO_GRAB_TV_SEASON_DELAY_MS);
    }

    return 1;
  }

  return 0;
}

async function runMovieAutoGrabber(): Promise<number> {
  let queued = 0;

  for (let page = 1; page <= env.AUTO_GRAB_MOVIE_PAGES; page += 1) {
    const movies = await fetchPopularMovies(page);
    for (const movie of movies) {
      if (movie.adult || !hasReleased(movie.releaseDate) || containsAdultTerms(movie.title, movie.originalTitle, movie.overview)) {
        continue;
      }

      if ((await listMovieSources(movie.tmdbId)).length > 0) {
        continue;
      }

      const target: AutomationTarget = {
        mediaType: "movie",
        tmdbId: movie.tmdbId
      };

      if (await shouldSkipTarget(target)) {
        continue;
      }

      const job = await queueAutomationTarget(target, "auto-grabber-movie");
      if (job) {
        queued += 1;
      }
    }
  }

  return queued;
}

async function runSeasonPackAutoGrabber(): Promise<number> {
  const lockedCandidate = await pickLockedSeasonAutoGrabberCandidate();
  if (lockedCandidate) {
    return queueNextSeasonForShow(lockedCandidate);
  }

  for (let page = 1; page <= env.AUTO_GRAB_TV_PAGES; page += 1) {
    const shows = await fetchPopularShows(page);
    for (const show of shows) {
      if (show.adult || containsAdultTerms(show.name, show.originalName, show.overview)) {
        continue;
      }

      const candidate = await buildSeasonAutoGrabberCandidate(show.tmdbId);
      if (!candidate) {
        continue;
      }

      seasonShowLockTmdbId = show.tmdbId;
      return queueNextSeasonForShow(candidate);
    }
  }

  seasonShowLockTmdbId = null;
  return 0;
}

export function getAutoGrabberStatus(): AutoGrabberStatus {
  return {
    running,
    lastStartedAt,
    lastFinishedAt,
    lastQueuedMovies,
    lastQueuedSeasonPacks,
    lastError,
    intervalMs: env.AUTO_GRAB_INTERVAL_MS
  };
}

export function triggerAutoGrabberCycle(): Promise<AutoGrabberStatus> {
  if (!automationConfigured || !tmdbConfigured) {
    return Promise.resolve(getAutoGrabberStatus());
  }

  if (inflightCycle) {
    return inflightCycle;
  }

  inflightCycle = (async () => {
    if (running) {
      return getAutoGrabberStatus();
    }

    clearSeasonFollowUpTimer();
    running = true;
    lastStartedAt = new Date().toISOString();
    lastError = null;

    try {
      const modes = await getAutomationModeSettings();
      let queuedMovies = 0;
      let queuedSeasonPacks = 0;

      if (modes.moviesEnabled) {
        queuedMovies = await runMovieAutoGrabber();
      }

      if (modes.seasonPacksEnabled) {
        queuedSeasonPacks = await runSeasonPackAutoGrabber();
      }

      lastQueuedMovies = queuedMovies;
      lastQueuedSeasonPacks = queuedSeasonPacks;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.error("Auto-grabber cycle failed:", lastError);
    } finally {
      lastFinishedAt = new Date().toISOString();
      running = false;
      inflightCycle = null;
    }

    return getAutoGrabberStatus();
  })();

  return inflightCycle;
}

export function startAutoGrabberWorker(): void {
  if (!automationConfigured || !tmdbConfigured || intervalHandle) {
    return;
  }

  intervalHandle = setInterval(() => {
    triggerAutoGrabberCycle();
  }, env.AUTO_GRAB_INTERVAL_MS);

  triggerAutoGrabberCycle();
}
