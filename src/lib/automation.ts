import { automationConfigured, env } from "./config";
import { containsAdultTerms, isAdultTmdbMetadata } from "./content-safety";
import { searchJackett } from "./jackett";
import { extractMediaGuess } from "./media-parser";
import { submitTorrentToQbittorrent } from "./qbittorrent";
import {
  createAutomationJob,
  getActiveAutomationJob,
  getAutomationJob,
  getCachedEpisode,
  getCachedTitle,
  getDueAutomationJobs,
  updateAutomationJob,
  upsertEpisode,
  upsertTitle,
  upsertVideoSource
} from "./repository";
import { createSeekAdvancedUploadTask, getSeekAdvancedUploadTask, getSeekVideoDetail } from "./seek";
import { fetchEpisodeByTmdbId, fetchSeasonEpisodesByTmdbId, fetchTitleByTmdbId, resolveMediaMatch } from "./tmdb";
import type {
  AutomationJobRow,
  AutomationTarget,
  CachedEpisodeRow,
  CachedTitleRow,
  ResolvedMediaMatch,
  TmdbEpisodeRecord,
  TmdbTitleRecord
} from "./types";

const processingJobs = new Set<string>();
let intervalHandle: NodeJS.Timeout | null = null;

interface QueueAutomationOptions {
  startDelayMs?: number;
  metadata?: Record<string, unknown> | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function plusMilliseconds(milliseconds: number): string {
  return new Date(Date.now() + milliseconds).toISOString();
}

function plusMinutes(minutes: number): string {
  return plusMilliseconds(minutes * 60_000);
}

function jobTarget(job: AutomationJobRow): AutomationTarget {
  return {
    mediaType: job.media_type,
    tmdbId: job.tmdb_id,
    seasonNumber: job.season_number ?? undefined,
    episodeNumber: job.episode_number ?? undefined
  };
}

function cachedTitleToRecord(title: CachedTitleRow): TmdbTitleRecord {
  return {
    mediaType: title.media_type,
    tmdbId: title.tmdb_id,
    title: title.title,
    originalTitle: title.original_title,
    releaseDate: title.release_date,
    posterPath: title.poster_path,
    backdropPath: title.backdrop_path,
    metadata: title.metadata ?? {}
  };
}

function cachedEpisodeToRecord(episode: CachedEpisodeRow): TmdbEpisodeRecord {
  return {
    showTmdbId: episode.show_tmdb_id,
    seasonNumber: episode.season_number,
    episodeNumber: episode.episode_number,
    name: episode.name,
    airDate: episode.air_date,
    metadata: episode.metadata ?? {}
  };
}

async function hydrateTitle(target: AutomationTarget): Promise<CachedTitleRow | null> {
  const cached = await getCachedTitle(target.mediaType, target.tmdbId);
  if (cached) {
    return cached;
  }

  const fetched = await fetchTitleByTmdbId(target.mediaType, target.tmdbId);
  if (!fetched) {
    return null;
  }

  await upsertTitle(fetched);
  return getCachedTitle(target.mediaType, target.tmdbId);
}

async function hydrateEpisode(target: AutomationTarget): Promise<CachedEpisodeRow | null> {
  if (target.mediaType !== "tv" || target.seasonNumber === undefined || target.episodeNumber === undefined) {
    return null;
  }

  const cached = await getCachedEpisode(target.tmdbId, target.seasonNumber, target.episodeNumber);
  if (cached) {
    return cached;
  }

  const fetched = await fetchEpisodeByTmdbId(target.tmdbId, target.seasonNumber, target.episodeNumber);
  if (!fetched) {
    return null;
  }

  await upsertEpisode(fetched);
  return getCachedEpisode(target.tmdbId, target.seasonNumber, target.episodeNumber);
}

function buildFallbackMatch(
  job: AutomationJobRow,
  title: CachedTitleRow | null,
  episode: CachedEpisodeRow | null,
  guess: ReturnType<typeof extractMediaGuess>,
  totalVideos: number
): ResolvedMediaMatch | null {
  if (!title) {
    return null;
  }

  const fallbackTitle = cachedTitleToRecord(title);
  if (job.media_type === "movie") {
    return { title: fallbackTitle, score: 1 };
  }

  const targetEpisode =
    episode ??
    (job.season_number !== null && job.episode_number !== null
      ? {
          show_tmdb_id: job.tmdb_id,
          season_number: job.season_number,
          episode_number: job.episode_number,
          name: null,
          air_date: null,
          metadata: {}
        }
      : null);

  if (!targetEpisode) {
    return null;
  }

  if (guess.type === "tv" && guess.seasonNumber === targetEpisode.season_number && guess.episodeNumber === targetEpisode.episode_number) {
    return {
      title: fallbackTitle,
      episode: cachedEpisodeToRecord(targetEpisode),
      score: 1
    };
  }

  if (totalVideos === 1) {
    return {
      title: fallbackTitle,
      episode: cachedEpisodeToRecord(targetEpisode),
      score: 0.5
    };
  }

  return null;
}

async function saveSeekVideos(job: AutomationJobRow, title: CachedTitleRow | null, episode: CachedEpisodeRow | null, videoIds: string[]) {
  let storedMatches = 0;

  for (const videoId of videoIds) {
    const detail = await getSeekVideoDetail(videoId);
    const rawName = detail.name || job.release_title || videoId;
    const guess = extractMediaGuess(rawName, rawName);
    const normalizedResolution = detail.resolution
      ? /\d{3,4}p/i.test(detail.resolution)
        ? detail.resolution.toLowerCase()
        : `${detail.resolution.toLowerCase()}p`
      : guess.resolution;

    const resolvedGuess = {
      ...guess,
      resolution: normalizedResolution
    };

    let match = await resolveMediaMatch(resolvedGuess);
    if (!match) {
      match = buildFallbackMatch(job, title, episode, resolvedGuess, videoIds.length);
    }

    if (match) {
      await upsertTitle(match.title);
      if (match.episode) {
        await upsertEpisode(match.episode);
      }
      storedMatches += 1;
    }

    await upsertVideoSource({
      provider: "seekstream",
      payload: {
        torrentName: rawName,
        contentPath: rawName,
        fileCode: videoId,
        embedUrl: `${env.SEEK_EMBED_BASE_URL}${videoId}`
      },
      guess: resolvedGuess,
      match
    });
  }

  return storedMatches;
}

async function failOrRetry(job: AutomationJobRow, message: string): Promise<AutomationJobRow> {
  const exhausted = job.attempt_count >= env.AUTOMATION_MAX_ATTEMPTS;
  return updateAutomationJob(job.id, {
    status: exhausted ? "failed" : "queued",
    last_error: message,
    next_attempt_at: exhausted ? nowIso() : plusMinutes(env.AUTOMATION_RETRY_MINUTES)
  });
}

async function processSearch(job: AutomationJobRow): Promise<void> {
  const target = jobTarget(job);
  const title = await hydrateTitle(target);
  const episode = await hydrateEpisode(target);

  if (!title) {
    await updateAutomationJob(job.id, {
      status: "failed",
      last_error: `TMDB title ${target.tmdbId} could not be loaded.`,
      next_attempt_at: nowIso()
    });
    return;
  }

  if (isAdultTmdbMetadata(title.metadata) || containsAdultTerms(title.title, title.original_title)) {
    await updateAutomationJob(job.id, {
      status: "failed",
      last_error: "Adult content was blocked by the filter.",
      next_attempt_at: nowIso()
    });
    return;
  }

  const searchingJob = await updateAutomationJob(job.id, {
    status: "searching",
    attempt_count: job.attempt_count + 1,
    last_error: null,
    next_attempt_at: nowIso()
  });

  const results = await searchJackett(target, title, episode);
  const best = results[0];

  if (!best?.downloadUrl) {
    await failOrRetry(searchingJob, "No Jackett release matched the request.");
    return;
  }

  await updateAutomationJob(job.id, {
    status: "submitting",
    release_title: best.title,
    release_guid: best.guid,
    release_link: best.downloadUrl,
    metadata: {
      ...(searchingJob.metadata ?? {}),
      jackettResult: best.raw
    },
    next_attempt_at: nowIso()
  });

  if (env.AUTOMATION_DELIVERY_MODE === "seek") {
    const task = await createSeekAdvancedUploadTask(best.downloadUrl, best.title);
    await updateAutomationJob(job.id, {
      status: "polling",
      seek_task_id: task.id,
      last_error: null,
      next_attempt_at: plusMilliseconds(env.AUTOMATION_POLL_INTERVAL_MS)
    });
    return;
  }

  const submission = await submitTorrentToQbittorrent(job.id, best.downloadUrl);
  await updateAutomationJob(job.id, {
    status: "downloading",
    last_error: null,
    next_attempt_at: nowIso(),
    metadata: {
      ...(searchingJob.metadata ?? {}),
      jackettResult: best.raw,
      qbTorrentHash: submission.hash,
      qbittorrent: {
        baseUrl: env.QBITTORRENT_BASE_URL,
        category: env.QBITTORRENT_CATEGORY,
        jobTag: submission.jobTag,
        hash: submission.hash,
        submittedAt: nowIso()
      }
    }
  });
}

async function processPolling(job: AutomationJobRow): Promise<void> {
  if (!job.seek_task_id) {
    await failOrRetry(job, "Seek task id was missing.");
    return;
  }

  const target = jobTarget(job);
  const title = await hydrateTitle(target);
  const episode = await hydrateEpisode(target);
  const task = await getSeekAdvancedUploadTask(job.seek_task_id);
  const status = task.status.toLowerCase();

  if (status.includes("complete")) {
    if (task.videos.length === 0) {
      await updateAutomationJob(job.id, {
        status: "polling",
        next_attempt_at: plusMilliseconds(env.AUTOMATION_POLL_INTERVAL_MS)
      });
      return;
    }

    const storedMatches = await saveSeekVideos(job, title, episode, task.videos);
    if (storedMatches === 0) {
      await failOrRetry(job, "Seek completed, but none of the generated videos matched the target media.");
      return;
    }

    await updateAutomationJob(job.id, {
      status: "completed",
      seek_video_ids: task.videos,
      last_error: null,
      next_attempt_at: nowIso()
    });
    return;
  }

  if (status.includes("fail") || task.error) {
    await failOrRetry(job, task.error ?? `Seek task ended with status ${task.status}.`);
    return;
  }

  await updateAutomationJob(job.id, {
    status: "polling",
    last_error: null,
    next_attempt_at: plusMilliseconds(env.AUTOMATION_POLL_INTERVAL_MS)
  });
}

async function processJob(jobId: string): Promise<void> {
  if (processingJobs.has(jobId)) {
    return;
  }

  processingJobs.add(jobId);

  try {
    const job = await getAutomationJob(jobId);
    if (!job || job.status === "completed" || job.status === "failed") {
      return;
    }

    if (job.status === "downloading") {
      return;
    }

    if (job.seek_task_id || job.status === "polling") {
      await processPolling(job);
      return;
    }

    await processSearch(job);
  } catch (error) {
    const job = await getAutomationJob(jobId);
    if (job && job.status !== "completed" && job.status !== "failed") {
      const message = error instanceof Error ? error.message : "Unknown automation error.";
      await failOrRetry(job, message);
    }
  } finally {
    processingJobs.delete(jobId);
  }
}

async function processDueJobs(): Promise<void> {
  if (!automationConfigured) {
    return;
  }

  const jobs = await getDueAutomationJobs(3);
  await Promise.all(jobs.map(async (job) => processJob(job.id)));
}

export async function queueAutomationTarget(
  target: AutomationTarget,
  triggerSource: string,
  options?: QueueAutomationOptions
): Promise<AutomationJobRow | null> {
  if (!automationConfigured) {
    return null;
  }

  const active = await getActiveAutomationJob(target);
  const delayMs = Math.max(0, options?.startDelayMs ?? 0);
  const scheduledFor = plusMilliseconds(delayMs);
  const job =
    active ??
    (await createAutomationJob(target, triggerSource, {
      nextAttemptAt: scheduledFor,
      metadata:
        delayMs > 0
          ? {
              ...(options?.metadata ?? {}),
              scheduledDelayMs: delayMs,
              scheduledFor
            }
          : options?.metadata ?? null
    }));

  if (delayMs === 0) {
    void processJob(job.id);
  }

  return job;
}

export async function queueSeasonAutomationTarget(
  showTmdbId: number,
  seasonNumber: number,
  triggerSource: string,
  options?: QueueAutomationOptions
): Promise<AutomationJobRow | null> {
  if (!automationConfigured) {
    return null;
  }

  const title = await hydrateTitle({
    mediaType: "tv",
    tmdbId: showTmdbId,
    seasonNumber
  });
  if (!title) {
    throw new Error(`TMDB season ${showTmdbId} S${String(seasonNumber).padStart(2, "0")} could not be loaded.`);
  }

  if (isAdultTmdbMetadata(title.metadata) || containsAdultTerms(title.title, title.original_title)) {
    const error = new Error("Adult content is blocked by the filter.");
    (error as Error & { status?: number }).status = 422;
    throw error;
  }

  const episodes = await fetchSeasonEpisodesByTmdbId(showTmdbId, seasonNumber);
  if (episodes.length === 0) {
    const error = new Error(`No TMDB episodes were found for ${showTmdbId} S${String(seasonNumber).padStart(2, "0")}.`);
    (error as Error & { status?: number }).status = 404;
    throw error;
  }

  await Promise.all(episodes.map(async (episode) => upsertEpisode(episode)));
  return queueAutomationTarget(
    {
      mediaType: "tv",
      tmdbId: showTmdbId,
      seasonNumber
    },
    triggerSource,
    options
  );
}

export async function getAutomationJobStatus(jobId: string): Promise<AutomationJobRow | null> {
  return getAutomationJob(jobId);
}

export function startAutomationWorker(): void {
  if (!automationConfigured || intervalHandle) {
    return;
  }

  intervalHandle = setInterval(() => {
    void processDueJobs();
  }, env.AUTOMATION_POLL_INTERVAL_MS);

  void processDueJobs();
}
