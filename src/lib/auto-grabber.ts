import { automationConfigured, env, tmdbConfigured } from "./config";
import { queueAutomationTarget, queueSeasonAutomationTarget } from "./automation";
import { containsAdultTerms, isAdultTmdbMetadata } from "./content-safety";
import {
  getAutomationModeSettings,
  getLatestAutomationJobForTarget,
  listMovieSources,
  listSeasonSources
} from "./repository";
import { fetchPopularMovies, fetchPopularShows, fetchSeasonEpisodesByTmdbId, fetchTitleByTmdbId } from "./tmdb";
import type { AutomationTarget, TmdbTitleRecord } from "./types";

let intervalHandle: NodeJS.Timeout | null = null;
let running = false;

function hasReleased(releaseDate: string | null | undefined): boolean {
  if (!releaseDate) {
    return false;
  }

  return new Date(releaseDate).getTime() <= Date.now();
}

function isRecentlyAttempted(updatedAt: string): boolean {
  return Date.now() - new Date(updatedAt).getTime() < env.AUTO_GRAB_REQUEUE_HOURS * 60 * 60 * 1000;
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

function latestRegularSeasonNumber(title: TmdbTitleRecord): number | null {
  const seasons = Array.isArray(title.metadata.seasons) ? title.metadata.seasons : [];
  const candidates = seasons
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
    .filter((value): value is number => value !== null);

  return candidates.length > 0 ? Math.max(...candidates) : null;
}

async function runMovieAutoGrabber(): Promise<void> {
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

      await queueAutomationTarget(target, "auto-grabber-movie");
    }
  }
}

async function runSeasonPackAutoGrabber(): Promise<void> {
  for (let page = 1; page <= env.AUTO_GRAB_TV_PAGES; page += 1) {
    const shows = await fetchPopularShows(page);
    for (const show of shows) {
      if (show.adult || containsAdultTerms(show.name, show.originalName, show.overview)) {
        continue;
      }

      const title = await fetchTitleByTmdbId("tv", show.tmdbId);
      if (!title || isAdultTmdbMetadata(title.metadata) || containsAdultTerms(title.title, title.originalTitle)) {
        continue;
      }

      const seasonNumber = latestRegularSeasonNumber(title);
      if (!seasonNumber) {
        continue;
      }

      const episodes = await fetchSeasonEpisodesByTmdbId(show.tmdbId, seasonNumber);
      if (episodes.length === 0) {
        continue;
      }

      const resolvedEpisodes = new Set(
        (await listSeasonSources(show.tmdbId, seasonNumber))
          .map((source) => source.episode_number)
          .filter((episodeNumber): episodeNumber is number => episodeNumber !== null)
      );

      if (resolvedEpisodes.size >= episodes.length) {
        continue;
      }

      const target: AutomationTarget = {
        mediaType: "tv",
        tmdbId: show.tmdbId,
        seasonNumber
      };

      if (await shouldSkipTarget(target)) {
        continue;
      }

      await queueSeasonAutomationTarget(show.tmdbId, seasonNumber, "auto-grabber-season-pack");
    }
  }
}

async function processAutoGrabberCycle(): Promise<void> {
  if (!automationConfigured || !tmdbConfigured || running) {
    return;
  }

  running = true;

  try {
    const modes = await getAutomationModeSettings();
    if (modes.moviesEnabled) {
      await runMovieAutoGrabber();
    }

    if (modes.seasonPacksEnabled) {
      await runSeasonPackAutoGrabber();
    }
  } catch (error) {
    console.error("Auto-grabber cycle failed:", error instanceof Error ? error.message : error);
  } finally {
    running = false;
  }
}

export function startAutoGrabberWorker(): void {
  if (!automationConfigured || !tmdbConfigured || intervalHandle) {
    return;
  }

  intervalHandle = setInterval(() => {
    void processAutoGrabberCycle();
  }, env.AUTO_GRAB_INTERVAL_MS);

  void processAutoGrabberCycle();
}
