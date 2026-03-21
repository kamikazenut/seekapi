import express, { type NextFunction, type Request, type Response } from "express";
import { ZodError, z } from "zod";

import { automationConfigured, env } from "./lib/config";
import { getAutoGrabberStatus, triggerAutoGrabberCycle } from "./lib/auto-grabber";
import { getAutomationJobStatus, queueAutomationTarget, queueSeasonAutomationTarget } from "./lib/automation";
import { containsAdultTerms, isAdultTmdbMetadata } from "./lib/content-safety";
import { renderDashboardPage } from "./lib/dashboard-page";
import { renderEmbedPage } from "./lib/embed-page";
import { extractMediaGuess } from "./lib/media-parser";
import {
  completeActiveAutomationJob,
  completeAutomationJob,
  findRecentAutomationJobByTorrentHash,
  getAutomationModeSettings,
  getDashboardStats,
  getCachedEpisode,
  getCachedTitle,
  listEpisodeSources,
  listMovieSources,
  listRecentAutomationJobs,
  listRecentVideoSources,
  pickBestSource,
  setAutomationModeSettings,
  upsertEpisode,
  upsertTitle,
  upsertVideoSource
} from "./lib/repository";
import { fetchEpisodeByTmdbId, fetchSeasonEpisodesByTmdbId, fetchTitleByTmdbId, resolveMediaMatch } from "./lib/tmdb";
import type {
  AutomationJobRow,
  CachedEpisodeRow,
  CachedTitleRow,
  MediaType,
  Provider,
  ResolvedMediaMatch,
  TmdbEpisodeRecord,
  TmdbTitleRecord
} from "./lib/types";

const callbackSchema = z.object({
  torrentHash: z.string().optional(),
  torrentName: z.string().min(1),
  contentPath: z.string().min(1),
  fileCode: z.string().min(1),
  embedUrl: z.string().url().optional()
});

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => {
    handler(request, response).catch(next);
  };
}

function asyncDashboardRoute(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response) => {
    handler(request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Dashboard action failed.";
      dashboardRedirect(response, { error: message });
    });
  };
}

function requireCallbackAuth(request: Request): void {
  if (!env.CALLBACK_AUTH_TOKEN) {
    return;
  }

  const bearerToken = request.headers.authorization?.replace(/^Bearer\s+/i, "").trim();
  const headerToken = request.header("x-callback-token")?.trim();
  const token = bearerToken || headerToken;

  if (token !== env.CALLBACK_AUTH_TOKEN) {
    const error = new Error("Unauthorized callback request.");
    (error as Error & { status?: number }).status = 401;
    throw error;
  }
}

function parsePositiveInt(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const error = new Error(`Invalid ${label}.`);
    (error as Error & { status?: number }).status = 400;
    throw error;
  }

  return parsed;
}

function getSingleParam(value: string | string[] | undefined, label: string): string {
  if (typeof value === "string") {
    return value;
  }

  const error = new Error(`Invalid ${label}.`);
  (error as Error & { status?: number }).status = 400;
  throw error;
}

function formatMovieSubtitle(title: CachedTitleRow | null, tmdbId: number): string {
  const year = title?.release_date?.slice(0, 4);
  return year ? `Movie | ${year} | TMDB ${tmdbId}` : `Movie | TMDB ${tmdbId}`;
}

function formatEpisodeSubtitle(
  title: CachedTitleRow | null,
  episode: CachedEpisodeRow | null,
  tmdbId: number,
  season: number,
  episodeNumber: number
): string {
  const episodeName = episode?.name ? ` | ${episode.name}` : "";
  const baseTitle = title?.title ? `${title.title} | ` : "";
  return `${baseTitle}S${String(season).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}${episodeName} | TMDB ${tmdbId}`;
}

function formatSeasonTarget(tmdbId: number, seasonNumber: number): string {
  return `TMDB ${tmdbId} S${String(seasonNumber).padStart(2, "0")}`;
}

function automationConfigMessage(): string {
  return env.AUTOMATION_DELIVERY_MODE === "seek"
    ? "Automation is not configured. Set Jackett and Seek credentials first."
    : "Automation is not configured. Set Jackett and qBittorrent credentials first.";
}

function automationFlowDescription(jobId: string, status: string): string {
  const pipeline =
    env.AUTOMATION_DELIVERY_MODE === "seek"
  return `No stream is stored yet. Automation job ${jobId} is ${status} through ${pipeline}.`;
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

async function hydrateTitle(mediaType: MediaType, tmdbId: number): Promise<CachedTitleRow | null> {
  const cached = await getCachedTitle(mediaType, tmdbId);
  if (cached) {
    return cached;
  }

  const fetched = await fetchTitleByTmdbId(mediaType, tmdbId);
  if (!fetched) {
    return null;
  }

  await upsertTitle(fetched);
  return getCachedTitle(mediaType, tmdbId);
}

async function hydrateEpisode(showTmdbId: number, seasonNumber: number, episodeNumber: number): Promise<CachedEpisodeRow | null> {
  const cached = await getCachedEpisode(showTmdbId, seasonNumber, episodeNumber);
  if (cached) {
    return cached;
  }

  const fetched = await fetchEpisodeByTmdbId(showTmdbId, seasonNumber, episodeNumber);
  if (!fetched) {
    return null;
  }

  await upsertEpisode(fetched);
  return getCachedEpisode(showTmdbId, seasonNumber, episodeNumber);
}

async function resolveMatchFromAutomationJob(job: AutomationJobRow, guess: ReturnType<typeof extractMediaGuess>): Promise<ResolvedMediaMatch | null> {
  const title = await hydrateTitle(job.media_type, job.tmdb_id);
  if (!title) {
    return null;
  }

  if (job.media_type === "movie") {
    return {
      title: cachedTitleToRecord(title),
      score: 1
    };
  }

  if (job.season_number === null || job.episode_number === null) {
    if (guess.type !== "tv" || guess.seasonNumber !== job.season_number || guess.episodeNumber === undefined) {
      return null;
    }

    const episode = await hydrateEpisode(job.tmdb_id, job.season_number, guess.episodeNumber);
    return {
      title: cachedTitleToRecord(title),
      episode:
        episode
          ? cachedEpisodeToRecord(episode)
          : {
              showTmdbId: job.tmdb_id,
              seasonNumber: job.season_number,
              episodeNumber: guess.episodeNumber,
              name: null,
              airDate: null,
              metadata: {}
            },
      score: 1
    };
  }

  const resolvedEpisodeNumber =
    guess.type === "tv" && guess.seasonNumber === job.season_number && guess.episodeNumber !== undefined
      ? guess.episodeNumber
      : job.episode_number;

  const episode = await hydrateEpisode(job.tmdb_id, job.season_number, resolvedEpisodeNumber);
  return {
    title: cachedTitleToRecord(title),
    episode:
      episode
        ? cachedEpisodeToRecord(episode)
        :
      {
        showTmdbId: job.tmdb_id,
        seasonNumber: job.season_number,
        episodeNumber: resolvedEpisodeNumber,
        name: null,
        airDate: null,
        metadata: {}
      },
    score: 1
  };
}

export const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: false }));

function getSingleQuery(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getSingleBodyValue(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  const error = new Error(`Invalid ${label}.`);
  (error as Error & { status?: number }).status = 400;
  throw error;
}

function dashboardRedirect(response: Response, params: Record<string, string>): void {
  const searchParams = new URLSearchParams(params);
  response.redirect(`/dashboard?${searchParams.toString()}`);
}

app.get("/", (_request, response) => {
  response.redirect("/dashboard");
});

app.get("/dashboard/actions/settings/automation-mode", (_request, response) => {
  response.redirect("/dashboard");
});

app.get("/dashboard/actions/automation/:target", (_request, response) => {
  response.redirect("/dashboard");
});

app.get(
  "/dashboard",
  asyncRoute(async (request, response) => {
    const [stats, jobs, sources, automationModes] = await Promise.all([
      getDashboardStats(),
      listRecentAutomationJobs(18),
      listRecentVideoSources(18),
      getAutomationModeSettings()
    ]);
    const autoGrabberStatus = getAutoGrabberStatus();

    response
      .type("html")
      .send(
        renderDashboardPage({
          siteName: env.SITE_NAME,
          automationEnabled: automationConfigured,
          autoMovieEnabled: automationModes.moviesEnabled,
          autoSeasonPackEnabled: automationModes.seasonPacksEnabled,
          autoGrabberStatus,
          stats,
          jobs,
          sources,
          notice: getSingleQuery(request.query.notice),
          error: getSingleQuery(request.query.error)
        })
      );
  })
);

app.post(
  "/dashboard/actions/settings/automation-mode",
  asyncDashboardRoute(async (request, response) => {
    const mode = getSingleBodyValue(request.body.mode, "mode");
    const enabled = getSingleBodyValue(request.body.enabled, "enabled") === "true";

    if (mode !== "movies" && mode !== "season-packs") {
      dashboardRedirect(response, { error: "Invalid automation mode." });
      return;
    }

    const settings = await setAutomationModeSettings(mode === "movies" ? { moviesEnabled: enabled } : { seasonPacksEnabled: enabled });
    const applied = mode === "movies" ? settings.moviesEnabled : settings.seasonPacksEnabled;

    if (applied !== enabled) {
      dashboardRedirect(response, {
        error: mode === "movies" ? "Movie auto-grabber state did not update." : "Season-pack auto-grabber state did not update."
      });
      return;
    }

    if (enabled) {
      const status = await triggerAutoGrabberCycle();
      if (status.lastError) {
        dashboardRedirect(response, { error: `Auto-grabber failed: ${status.lastError}` });
        return;
      }

      dashboardRedirect(response, {
        notice:
          mode === "movies"
            ? `Movie auto-grabber enabled. Immediate scan finished with ${status.lastQueuedMovies} movies queued.`
            : `Season-pack auto-grabber enabled. Immediate scan finished with ${status.lastQueuedSeasonPacks} seasons queued.`
      });
      return;
    }

    dashboardRedirect(response, {
      notice: mode === "movies" ? "Movie auto-grabber disabled." : "Season-pack auto-grabber disabled."
    });
  })
);

app.post(
  "/dashboard/actions/automation/run-now",
  asyncDashboardRoute(async (_request, response) => {
    if (!automationConfigured) {
      dashboardRedirect(response, { error: "Automation is not configured yet." });
      return;
    }

    const status = await triggerAutoGrabberCycle();
    if (status.lastError) {
      dashboardRedirect(response, { error: `Auto-grabber failed: ${status.lastError}` });
      return;
    }

    dashboardRedirect(response, {
      notice: `Auto-grabber finished. Queued ${status.lastQueuedMovies} movies and ${status.lastQueuedSeasonPacks} seasons.`
    });
  })
);

app.post(
  "/dashboard/actions/automation/movie",
  asyncDashboardRoute(async (request, response) => {
    if (!automationConfigured) {
      dashboardRedirect(response, { error: "Automation is not configured yet." });
      return;
    }

    const tmdbId = parsePositiveInt(getSingleBodyValue(request.body.tmdbId, "tmdbId"), "tmdbId");
    const job = await queueAutomationTarget(
      {
        mediaType: "movie",
        tmdbId
      },
      "manual-dashboard"
    );

    if (!job) {
      dashboardRedirect(response, { error: "Automation job could not be created." });
      return;
    }

    dashboardRedirect(response, { notice: `Queued movie job ${job.id} for TMDB ${tmdbId}.` });
  })
);

app.post(
  "/dashboard/actions/automation/season",
  asyncDashboardRoute(async (request, response) => {
    if (!automationConfigured) {
      dashboardRedirect(response, { error: "Automation is not configured yet." });
      return;
    }

    const tmdbId = parsePositiveInt(getSingleBodyValue(request.body.tmdbId, "tmdbId"), "tmdbId");
    const seasonNumber = parsePositiveInt(getSingleBodyValue(request.body.season, "season"), "season");
    const job = await queueSeasonAutomationTarget(tmdbId, seasonNumber, "manual-dashboard-season");

    if (!job) {
      dashboardRedirect(response, { error: "Automation job could not be created." });
      return;
    }

    dashboardRedirect(response, {
      notice: `Queued season job ${job.id} for ${formatSeasonTarget(tmdbId, seasonNumber)}.`
    });
  })
);

app.post(
  "/dashboard/actions/automation/tv",
  asyncDashboardRoute(async (request, response) => {
    if (!automationConfigured) {
      dashboardRedirect(response, { error: "Automation is not configured yet." });
      return;
    }

    const tmdbId = parsePositiveInt(getSingleBodyValue(request.body.tmdbId, "tmdbId"), "tmdbId");
    const seasonNumber = parsePositiveInt(getSingleBodyValue(request.body.season, "season"), "season");
    const episodeNumber = parsePositiveInt(getSingleBodyValue(request.body.episode, "episode"), "episode");
    const job = await queueAutomationTarget(
      {
        mediaType: "tv",
        tmdbId,
        seasonNumber,
        episodeNumber
      },
      "manual-dashboard"
    );

    if (!job) {
      dashboardRedirect(response, { error: "Automation job could not be created." });
      return;
    }

    dashboardRedirect(response, {
      notice: `Queued TV job ${job.id} for TMDB ${tmdbId} S${seasonNumber}E${episodeNumber}.`
    });
  })
);

app.get(
  "/healthz",
  asyncRoute(async (_request, response) => {
    response.json({ ok: true, service: env.SITE_NAME, automationEnabled: automationConfigured });
  })
);

app.post(
  "/v1/automation/movie/:tmdbId",
  asyncRoute(async (request, response) => {
    const tmdbId = parsePositiveInt(getSingleParam(request.params.tmdbId, "tmdbId"), "tmdbId");
    const job = await queueAutomationTarget(
      {
        mediaType: "movie",
        tmdbId
      },
      "manual"
    );

    if (!job) {
      response.status(503).json({
        message: automationConfigMessage()
      });
      return;
    }

    response.status(202).json({ ok: true, job });
  })
);

app.post(
  "/v1/automation/tv/:tmdbId/:season",
  asyncRoute(async (request, response) => {
    const tmdbId = parsePositiveInt(getSingleParam(request.params.tmdbId, "tmdbId"), "tmdbId");
    const seasonNumber = parsePositiveInt(getSingleParam(request.params.season, "season"), "season");
    const job = await queueSeasonAutomationTarget(tmdbId, seasonNumber, "manual-season");

    if (!job) {
      response.status(503).json({
        message: automationConfigMessage()
      });
      return;
    }

    response.status(202).json({ ok: true, job });
  })
);

app.post(
  "/v1/automation/tv/:tmdbId/:season/:episode",
  asyncRoute(async (request, response) => {
    const tmdbId = parsePositiveInt(getSingleParam(request.params.tmdbId, "tmdbId"), "tmdbId");
    const seasonNumber = parsePositiveInt(getSingleParam(request.params.season, "season"), "season");
    const episodeNumber = parsePositiveInt(getSingleParam(request.params.episode, "episode"), "episode");
    const job = await queueAutomationTarget(
      {
        mediaType: "tv",
        tmdbId,
        seasonNumber,
        episodeNumber
      },
      "manual"
    );

    if (!job) {
      response.status(503).json({
        message: automationConfigMessage()
      });
      return;
    }

    response.status(202).json({ ok: true, job });
  })
);

app.get(
  "/v1/automation/jobs/:jobId",
  asyncRoute(async (request, response) => {
    const jobId = getSingleParam(request.params.jobId, "jobId");
    const job = await getAutomationJobStatus(jobId);

    if (!job) {
      response.status(404).json({ message: "Automation job not found." });
      return;
    }

    response.json({ ok: true, job });
  })
);

app.post(
  "/v1/callbacks/:provider",
  asyncRoute(async (request, response) => {
    requireCallbackAuth(request);

    const provider = z.enum(["seekstream", "bigshare"]).parse(request.params.provider) as Provider;
    const payload = callbackSchema.parse(request.body);
    if (containsAdultTerms(payload.torrentName, payload.contentPath)) {
      response.status(422).json({ message: "Adult content is blocked by the filter." });
      return;
    }

    const guess = extractMediaGuess(payload.torrentName, payload.contentPath);
    const linkedJob = payload.torrentHash ? await findRecentAutomationJobByTorrentHash(payload.torrentHash) : null;
    const match = (linkedJob ? await resolveMatchFromAutomationJob(linkedJob, guess) : null) ?? (await resolveMediaMatch(guess));

    if (match && isAdultTmdbMetadata(match.title.metadata)) {
      response.status(422).json({ message: "Adult content is blocked by the filter." });
      return;
    }

    if (match) {
      await upsertTitle(match.title);
      if (match.episode) {
        await upsertEpisode(match.episode);
      }
    }

    const source = await upsertVideoSource({ provider, payload, guess, match });

    if (provider === "seekstream") {
      const completionMetadata = {
        callbackProvider: provider,
        callbackSourceId: source.id,
        callbackReceivedAt: new Date().toISOString(),
        callbackTorrentHash: payload.torrentHash ?? null
      };

      if (linkedJob) {
        await completeAutomationJob(linkedJob.id, {
          seekVideoIds: [payload.fileCode],
          metadata: completionMetadata
        });
      } else if (match) {
        await completeActiveAutomationJob(
          {
            mediaType: match.title.mediaType,
            tmdbId: match.title.tmdbId,
            seasonNumber: match.episode?.seasonNumber,
            episodeNumber: match.episode?.episodeNumber
          },
          {
            seekVideoIds: [payload.fileCode],
            metadata: completionMetadata
          }
        );
      }
    }

    response.json({
      ok: true,
      provider,
      resolved: Boolean(match),
      guess,
      match: match
        ? {
            mediaType: match.title.mediaType,
            tmdbId: match.title.tmdbId,
            title: match.title.title,
            seasonNumber: match.episode?.seasonNumber ?? null,
            episodeNumber: match.episode?.episodeNumber ?? null,
            score: Number(match.score.toFixed(3))
          }
        : null,
      source: {
        id: source.id,
        embedUrl: source.embed_url
      }
    });
  })
);

app.get(
  "/embed/movie/:tmdbId",
  asyncRoute(async (request, response) => {
    const tmdbId = parsePositiveInt(getSingleParam(request.params.tmdbId, "tmdbId"), "tmdbId");
    const title = await hydrateTitle("movie", tmdbId);
    const source = pickBestSource(await listMovieSources(tmdbId));
    const blocked = title ? isAdultTmdbMetadata(title.metadata) || containsAdultTerms(title.title, title.original_title) : false;
    const job = source
      ? null
      : blocked
        ? null
        : await queueAutomationTarget(
          {
            mediaType: "movie",
            tmdbId
          },
          "embed"
        );

    response
      .status(source ? 200 : 404)
      .type("html")
      .send(
        renderEmbedPage({
          siteName: env.SITE_NAME,
          title: title?.title ?? `Movie ${tmdbId}`,
          subtitle: formatMovieSubtitle(title, tmdbId),
          description: source
            ? "Resolved automatically from the upload callback and served from the highest-priority provider."
            : blocked
              ? "This title was blocked by the adult-content filter."
            : job
              ? automationFlowDescription(job.id, job.status)
              : "No resolved stream source is stored for this movie yet, and automation is not configured.",
          embedUrl: source?.embed_url ?? null,
          provider: source?.provider ?? null,
          resolution: source?.resolution ?? null,
          posterPath: title?.poster_path ?? null,
          backdropPath: title?.backdrop_path ?? null
        })
      );
  })
);

app.get(
  "/embed/tv/:tmdbId/:season/:episode",
  asyncRoute(async (request, response) => {
    const tmdbId = parsePositiveInt(getSingleParam(request.params.tmdbId, "tmdbId"), "tmdbId");
    const seasonNumber = parsePositiveInt(getSingleParam(request.params.season, "season"), "season");
    const episodeNumber = parsePositiveInt(getSingleParam(request.params.episode, "episode"), "episode");
    const title = await hydrateTitle("tv", tmdbId);
    const episode = await hydrateEpisode(tmdbId, seasonNumber, episodeNumber);
    const source = pickBestSource(await listEpisodeSources(tmdbId, seasonNumber, episodeNumber));
    const blocked = title ? isAdultTmdbMetadata(title.metadata) || containsAdultTerms(title.title, title.original_title, episode?.name) : false;
    const job = source
      ? null
      : blocked
        ? null
        : await queueSeasonAutomationTarget(tmdbId, seasonNumber, "embed-season");

    response
      .status(source ? 200 : 404)
      .type("html")
      .send(
        renderEmbedPage({
          siteName: env.SITE_NAME,
          title: title?.title ?? `TV Show ${tmdbId}`,
          subtitle: formatEpisodeSubtitle(title, episode, tmdbId, seasonNumber, episodeNumber),
          description: source
            ? "Resolved automatically from the upload callback and matched to this episode in TMDB."
            : blocked
              ? "This title was blocked by the adult-content filter."
            : job
              ? automationFlowDescription(job.id, job.status)
              : "No resolved stream source is stored for this episode yet, and automation is not configured.",
          embedUrl: source?.embed_url ?? null,
          provider: source?.provider ?? null,
          resolution: source?.resolution ?? null,
          posterPath: title?.poster_path ?? null,
          backdropPath: title?.backdrop_path ?? null
        })
      );
  })
);

app.use((_request, response) => {
  response.status(404).json({ message: "Not found" });
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof ZodError) {
    response.status(400).json({
      message: "Invalid request.",
      issues: error.issues.map((issue) => issue.message)
    });
    return;
  }

  const status = typeof error === "object" && error && "status" in error && typeof error.status === "number" ? error.status : 500;
  const message = error instanceof Error ? error.message : "Internal server error";

  response.status(status).json({ message });
});
