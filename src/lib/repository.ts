import { promises as fs } from "node:fs";
import path from "node:path";

import { env } from "./config";
import { supabase } from "./supabase";
import type {
  AutomationModeSettings,
  AutomationJobRow,
  AutomationJobStatus,
  AutomationTarget,
  CachedEpisodeRow,
  CachedTitleRow,
  DashboardStats,
  MediaGuess,
  MediaType,
  Provider,
  ResolvedMediaMatch,
  TmdbEpisodeRecord,
  TmdbTitleRecord,
  UploadCallbackPayload,
  VideoSourceRow
} from "./types";

const ACTIVE_AUTOMATION_STATUSES: AutomationJobStatus[] = ["queued", "searching", "submitting", "polling", "downloading"];
const DUE_AUTOMATION_STATUSES: AutomationJobStatus[] = ["queued", "searching", "submitting", "polling"];
const APP_SETTING_AUTO_GRAB_MOVIES = "auto_grab_movies_enabled";
const APP_SETTING_AUTO_GRAB_SEASON_PACKS = "auto_grab_season_packs_enabled";
const APP_SETTINGS_FILE_PATH = path.resolve(process.cwd(), ".data", "app-settings.json");
const runtimeAppSettingOverrides = new Map<string, boolean>();

function fallbackEmbedUrl(provider: Provider, providerVideoId: string): string {
  if (provider === "seekstream") {
    return `${env.SEEK_EMBED_BASE_URL}${providerVideoId}`;
  }

  return `https://bigshare.io/embed-${providerVideoId}.html`;
}

function formatSupabaseError(error: { message?: string | null; details?: string | null; hint?: string | null; code?: string | null } | null): string {
  if (!error) {
    return "";
  }

  const parts = [error.message, error.details, error.hint, error.code ? `code=${error.code}` : null]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);

  return parts.join(" | ");
}

function throwIfError(error: { message?: string | null; details?: string | null; hint?: string | null; code?: string | null } | null): void {
  if (error) {
    const formattedError = formatSupabaseError(error) || "Supabase request failed.";

    if (/row-level security/i.test(formattedError)) {
      throw new Error(
        `${formattedError}. This usually means SUPABASE_SERVICE_ROLE_KEY is not a service-role or sb_secret key.`
      );
    }

    throw new Error(formattedError);
  }
}

function isAppSettingsStorageError(error: { message?: string | null; details?: string | null; hint?: string | null; code?: string | null } | null): boolean {
  const formattedError = formatSupabaseError(error);
  return Boolean(
    formattedError &&
      (/relation\s+"?public\.app_settings"?\s+does not exist/i.test(formattedError) ||
        /public\.app_settings/i.test(formattedError) ||
        (/schema cache/i.test(formattedError) && /app_settings/i.test(formattedError)))
  );
}

async function readFileAppSettings(): Promise<Record<string, boolean>> {
  try {
    const raw = await fs.readFile(APP_SETTINGS_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[0] === "string" && typeof entry[1] === "boolean")
    );
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return {};
    }

    console.error("Failed reading file-backed app settings:", error);
    return {};
  }
}

async function readFileAppSetting(key: string): Promise<boolean | undefined> {
  const settings = await readFileAppSettings();
  return settings[key];
}

async function writeFileAppSetting(key: string, enabled: boolean): Promise<void> {
  const settings = await readFileAppSettings();
  settings[key] = enabled;

  await fs.mkdir(path.dirname(APP_SETTINGS_FILE_PATH), { recursive: true });
  await fs.writeFile(APP_SETTINGS_FILE_PATH, JSON.stringify(settings, null, 2), "utf8");
}

function normalizeTorrentHash(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function readJobTorrentHash(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) {
    return null;
  }

  const directHash = metadata.qbTorrentHash;
  if (typeof directHash === "string") {
    return normalizeTorrentHash(directHash);
  }

  const qbittorrent = metadata.qbittorrent;
  if (qbittorrent && typeof qbittorrent === "object" && "hash" in qbittorrent && typeof qbittorrent.hash === "string") {
    return normalizeTorrentHash(qbittorrent.hash);
  }

  return null;
}

function buildAutomationJobSelectQuery() {
  return "id, media_type, tmdb_id, season_number, episode_number, status, trigger_source, attempt_count, release_title, release_guid, release_link, seek_task_id, seek_video_ids, last_error, next_attempt_at, metadata, created_at, updated_at";
}

async function getBooleanAppSetting(key: string, fallback: boolean): Promise<boolean> {
  const { data, error } = await supabase.from("app_settings").select("value").eq("key", key).maybeSingle<{ value: unknown }>();
  if (isAppSettingsStorageError(error)) {
    const fileValue = await readFileAppSetting(key);
    if (typeof fileValue === "boolean") {
      runtimeAppSettingOverrides.set(key, fileValue);
      return fileValue;
    }

    if (runtimeAppSettingOverrides.has(key)) {
      return runtimeAppSettingOverrides.get(key) ?? fallback;
    }

    return fallback;
  }

  throwIfError(error);

  if (!data || typeof data.value !== "object" || data.value === null || !("enabled" in data.value)) {
    return fallback;
  }

  return Boolean((data.value as { enabled?: unknown }).enabled);
}

async function setBooleanAppSetting(key: string, enabled: boolean): Promise<void> {
  const { error } = await supabase.from("app_settings").upsert(
    {
      key,
      value: {
        enabled
      }
    },
    {
      onConflict: "key"
    }
  );

  if (isAppSettingsStorageError(error)) {
    try {
      await writeFileAppSetting(key, enabled);
      runtimeAppSettingOverrides.set(key, enabled);
      return;
    } catch (writeError) {
      runtimeAppSettingOverrides.set(key, enabled);
      console.error("Failed writing file-backed app settings, using in-memory override only:", writeError);
      return;
    }
  }

  throwIfError(error);
  runtimeAppSettingOverrides.delete(key);
}

export async function upsertTitle(title: TmdbTitleRecord): Promise<void> {
  const { error } = await supabase.from("media_titles").upsert(
    {
      media_type: title.mediaType,
      tmdb_id: title.tmdbId,
      title: title.title,
      original_title: title.originalTitle ?? null,
      release_date: title.releaseDate ?? null,
      poster_path: title.posterPath ?? null,
      backdrop_path: title.backdropPath ?? null,
      metadata: title.metadata
    },
    {
      onConflict: "media_type,tmdb_id"
    }
  );

  throwIfError(error);
}

export async function upsertEpisode(episode: TmdbEpisodeRecord): Promise<void> {
  const { error } = await supabase.from("media_episodes").upsert(
    {
      show_tmdb_id: episode.showTmdbId,
      season_number: episode.seasonNumber,
      episode_number: episode.episodeNumber,
      name: episode.name ?? null,
      air_date: episode.airDate ?? null,
      metadata: episode.metadata
    },
    {
      onConflict: "show_tmdb_id,season_number,episode_number"
    }
  );

  throwIfError(error);
}

export async function upsertVideoSource(params: {
  provider: Provider;
  payload: UploadCallbackPayload;
  guess: MediaGuess;
  match: ResolvedMediaMatch | null;
}): Promise<VideoSourceRow> {
  const { provider, payload, guess, match } = params;
  const embedUrl = payload.embedUrl?.trim() || fallbackEmbedUrl(provider, payload.fileCode);

  const { data, error } = await supabase
    .from("video_sources")
    .upsert(
      {
        provider,
        provider_video_id: payload.fileCode,
        embed_url: embedUrl,
        torrent_hash: payload.torrentHash ?? null,
        torrent_name: payload.torrentName,
        content_path: payload.contentPath,
        media_type: match?.title.mediaType ?? guess.type,
        tmdb_id: match?.title.tmdbId ?? null,
        season_number: match?.episode?.seasonNumber ?? guess.seasonNumber ?? null,
        episode_number: match?.episode?.episodeNumber ?? guess.episodeNumber ?? null,
        guessed_title: guess.title,
        guessed_year: guess.year ?? null,
        resolution: guess.resolution ?? null,
        file_name: guess.fileName,
        status: match ? "resolved" : "unresolved",
        callback_payload: payload,
        tmdb_payload: match
          ? {
              score: match.score,
              title: match.title.metadata,
              episode: match.episode?.metadata ?? null
            }
          : null
      },
      {
        onConflict: "provider,provider_video_id"
      }
    )
    .select("*")
    .single<VideoSourceRow>();

  throwIfError(error);
  if (!data) {
    throw new Error("Supabase did not return the saved video source.");
  }
  return data;
}

export async function getCachedTitle(mediaType: MediaType, tmdbId: number): Promise<CachedTitleRow | null> {
  const { data, error } = await supabase
    .from("media_titles")
    .select("media_type, tmdb_id, title, original_title, release_date, poster_path, backdrop_path, metadata")
    .eq("media_type", mediaType)
    .eq("tmdb_id", tmdbId)
    .maybeSingle<CachedTitleRow>();

  throwIfError(error);
  return data;
}

export async function getCachedEpisode(
  showTmdbId: number,
  seasonNumber: number,
  episodeNumber: number
): Promise<CachedEpisodeRow | null> {
  const { data, error } = await supabase
    .from("media_episodes")
    .select("show_tmdb_id, season_number, episode_number, name, air_date, metadata")
    .eq("show_tmdb_id", showTmdbId)
    .eq("season_number", seasonNumber)
    .eq("episode_number", episodeNumber)
    .maybeSingle<CachedEpisodeRow>();

  throwIfError(error);
  return data;
}

export async function listMovieSources(tmdbId: number): Promise<VideoSourceRow[]> {
  const { data, error } = await supabase
    .from("video_sources")
    .select(
      "id, provider, provider_video_id, embed_url, torrent_hash, torrent_name, content_path, media_type, tmdb_id, season_number, episode_number, guessed_title, guessed_year, resolution, file_name, status, callback_payload, tmdb_payload, updated_at"
    )
    .eq("status", "resolved")
    .eq("media_type", "movie")
    .eq("tmdb_id", tmdbId)
    .order("updated_at", { ascending: false })
    .returns<VideoSourceRow[]>();

  throwIfError(error);
  return data ?? [];
}

export async function listEpisodeSources(
  showTmdbId: number,
  seasonNumber: number,
  episodeNumber: number
): Promise<VideoSourceRow[]> {
  const { data, error } = await supabase
    .from("video_sources")
    .select(
      "id, provider, provider_video_id, embed_url, torrent_hash, torrent_name, content_path, media_type, tmdb_id, season_number, episode_number, guessed_title, guessed_year, resolution, file_name, status, callback_payload, tmdb_payload, updated_at"
    )
    .eq("status", "resolved")
    .eq("media_type", "tv")
    .eq("tmdb_id", showTmdbId)
    .eq("season_number", seasonNumber)
    .eq("episode_number", episodeNumber)
    .order("updated_at", { ascending: false })
    .returns<VideoSourceRow[]>();

  throwIfError(error);
  return data ?? [];
}

export async function listSeasonSources(showTmdbId: number, seasonNumber: number): Promise<VideoSourceRow[]> {
  const { data, error } = await supabase
    .from("video_sources")
    .select(
      "id, provider, provider_video_id, embed_url, torrent_hash, torrent_name, content_path, media_type, tmdb_id, season_number, episode_number, guessed_title, guessed_year, resolution, file_name, status, callback_payload, tmdb_payload, updated_at"
    )
    .eq("status", "resolved")
    .eq("media_type", "tv")
    .eq("tmdb_id", showTmdbId)
    .eq("season_number", seasonNumber)
    .not("episode_number", "is", null)
    .returns<VideoSourceRow[]>();

  throwIfError(error);
  return data ?? [];
}

function resolutionRank(resolution: string | null): number {
  const ranks: Record<string, number> = {
    "2160p": 4,
    "1080p": 3,
    "720p": 2,
    "480p": 1
  };

  return resolution ? ranks[resolution.toLowerCase()] ?? 0 : 0;
}

function providerRank(provider: Provider): number {
  return provider === "seekstream" ? 0 : 1;
}

export function pickBestSource(sources: VideoSourceRow[]): VideoSourceRow | null {
  if (sources.length === 0) {
    return null;
  }

  return [...sources].sort((left, right) => {
    const providerDiff = providerRank(left.provider) - providerRank(right.provider);
    if (providerDiff !== 0) {
      return providerDiff;
    }

    const resolutionDiff = resolutionRank(right.resolution) - resolutionRank(left.resolution);
    if (resolutionDiff !== 0) {
      return resolutionDiff;
    }

    return new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime();
  })[0];
}

export async function getActiveAutomationJob(target: AutomationTarget): Promise<AutomationJobRow | null> {
  const baseQuery = supabase
    .from("automation_jobs")
    .select(buildAutomationJobSelectQuery())
    .in("status", ACTIVE_AUTOMATION_STATUSES)
    .eq("media_type", target.mediaType)
    .eq("tmdb_id", target.tmdbId)
    .order("created_at", { ascending: false });

  let query;
  if (target.mediaType === "tv") {
    query = baseQuery.eq("season_number", target.seasonNumber ?? null);
    query =
      target.episodeNumber === undefined
        ? query.is("episode_number", null)
        : query.eq("episode_number", target.episodeNumber);
  } else {
    query = baseQuery.is("season_number", null).is("episode_number", null);
  }

  const { data, error } = await query.maybeSingle<AutomationJobRow>();

  throwIfError(error);
  return data;
}

export async function createAutomationJob(target: AutomationTarget, triggerSource: string): Promise<AutomationJobRow> {
  const payload = {
    media_type: target.mediaType,
    tmdb_id: target.tmdbId,
    season_number: target.mediaType === "tv" ? target.seasonNumber ?? null : null,
    episode_number: target.mediaType === "tv" ? target.episodeNumber ?? null : null,
    trigger_source: triggerSource,
    status: "queued",
    next_attempt_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from("automation_jobs")
    .insert(payload)
    .select(buildAutomationJobSelectQuery())
    .single<AutomationJobRow>();

  if (error) {
    const existing = await getActiveAutomationJob(target);
    if (existing) {
      return existing;
    }

    throw new Error(error.message);
  }

  if (!data) {
    throw new Error("Supabase did not return the saved automation job.");
  }

  return data;
}

export async function getAutomationJob(jobId: string): Promise<AutomationJobRow | null> {
  const { data, error } = await supabase
    .from("automation_jobs")
    .select(buildAutomationJobSelectQuery())
    .eq("id", jobId)
    .maybeSingle<AutomationJobRow>();

  throwIfError(error);
  return data;
}

export async function getLatestAutomationJobForTarget(target: AutomationTarget): Promise<AutomationJobRow | null> {
  let query = supabase
    .from("automation_jobs")
    .select(buildAutomationJobSelectQuery())
    .eq("media_type", target.mediaType)
    .eq("tmdb_id", target.tmdbId)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (target.mediaType === "tv") {
    query = query.eq("season_number", target.seasonNumber ?? null);
    query = target.episodeNumber === undefined ? query.is("episode_number", null) : query.eq("episode_number", target.episodeNumber);
  } else {
    query = query.is("season_number", null).is("episode_number", null);
  }

  const { data, error } = await query.maybeSingle<AutomationJobRow>();

  throwIfError(error);
  return data;
}

export async function getDueAutomationJobs(limit = 3): Promise<AutomationJobRow[]> {
  const { data, error } = await supabase
    .from("automation_jobs")
    .select(buildAutomationJobSelectQuery())
    .in("status", DUE_AUTOMATION_STATUSES)
    .lte("next_attempt_at", new Date().toISOString())
    .order("next_attempt_at", { ascending: true })
    .limit(limit)
    .returns<AutomationJobRow[]>();

  throwIfError(error);
  return data ?? [];
}

export async function updateAutomationJob(
  jobId: string,
  patch: Partial<AutomationJobRow> & { status?: AutomationJobStatus }
): Promise<AutomationJobRow> {
  const { data, error } = await supabase
    .from("automation_jobs")
    .update({
      media_type: patch.media_type,
      tmdb_id: patch.tmdb_id,
      season_number: patch.season_number,
      episode_number: patch.episode_number,
      status: patch.status,
      trigger_source: patch.trigger_source,
      attempt_count: patch.attempt_count,
      release_title: patch.release_title,
      release_guid: patch.release_guid,
      release_link: patch.release_link,
      seek_task_id: patch.seek_task_id,
      seek_video_ids: patch.seek_video_ids,
      last_error: patch.last_error,
      next_attempt_at: patch.next_attempt_at,
      metadata: patch.metadata
    })
    .eq("id", jobId)
    .select(buildAutomationJobSelectQuery())
    .single<AutomationJobRow>();

  throwIfError(error);
  if (!data) {
    throw new Error("Supabase did not return the updated automation job.");
  }
  return data;
}

export async function findRecentAutomationJobByTorrentHash(torrentHash: string): Promise<AutomationJobRow | null> {
  const normalizedHash = normalizeTorrentHash(torrentHash);
  if (!normalizedHash) {
    return null;
  }

  const { data, error } = await supabase
    .from("automation_jobs")
    .select(buildAutomationJobSelectQuery())
    .order("created_at", { ascending: false })
    .limit(100)
    .returns<AutomationJobRow[]>();

  throwIfError(error);
  return (data ?? []).find((job) => readJobTorrentHash(job.metadata) === normalizedHash) ?? null;
}

export async function completeAutomationJob(
  jobId: string,
  patch?: {
    metadata?: Record<string, unknown> | null;
    seekVideoIds?: string[] | null;
  }
): Promise<AutomationJobRow> {
  const job = await getAutomationJob(jobId);
  if (!job) {
    throw new Error("Automation job not found.");
  }

  return updateAutomationJob(jobId, {
    status: "completed",
    seek_video_ids: patch?.seekVideoIds ?? job.seek_video_ids,
    last_error: null,
    next_attempt_at: new Date().toISOString(),
    metadata: {
      ...(job.metadata ?? {}),
      ...(patch?.metadata ?? {}),
      completedAt: new Date().toISOString()
    }
  });
}

export async function completeActiveAutomationJob(
  target: AutomationTarget,
  patch?: {
    metadata?: Record<string, unknown> | null;
    seekVideoIds?: string[] | null;
  }
): Promise<AutomationJobRow | null> {
  const active = await getActiveAutomationJob(target);
  if (!active) {
    return null;
  }

  return completeAutomationJob(active.id, patch);
}

export async function listRecentAutomationJobs(limit = 20): Promise<AutomationJobRow[]> {
  const { data, error } = await supabase
    .from("automation_jobs")
    .select(buildAutomationJobSelectQuery())
    .order("updated_at", { ascending: false })
    .limit(limit)
    .returns<AutomationJobRow[]>();

  throwIfError(error);
  return data ?? [];
}

export async function getAutomationModeSettings(): Promise<AutomationModeSettings> {
  const [moviesEnabled, seasonPacksEnabled] = await Promise.all([
    getBooleanAppSetting(APP_SETTING_AUTO_GRAB_MOVIES, env.AUTOMATION_AUTO_MOVIES),
    getBooleanAppSetting(APP_SETTING_AUTO_GRAB_SEASON_PACKS, env.AUTOMATION_AUTO_SEASON_PACKS)
  ]);

  return {
    moviesEnabled,
    seasonPacksEnabled
  };
}

export async function setAutomationModeSettings(patch: Partial<AutomationModeSettings>): Promise<AutomationModeSettings> {
  if (patch.moviesEnabled !== undefined) {
    await setBooleanAppSetting(APP_SETTING_AUTO_GRAB_MOVIES, patch.moviesEnabled);
  }

  if (patch.seasonPacksEnabled !== undefined) {
    await setBooleanAppSetting(APP_SETTING_AUTO_GRAB_SEASON_PACKS, patch.seasonPacksEnabled);
  }

  return getAutomationModeSettings();
}

export async function listRecentVideoSources(limit = 20): Promise<VideoSourceRow[]> {
  const { data, error } = await supabase
    .from("video_sources")
    .select(
      "id, provider, provider_video_id, embed_url, torrent_hash, torrent_name, content_path, media_type, tmdb_id, season_number, episode_number, guessed_title, guessed_year, resolution, file_name, status, callback_payload, tmdb_payload, updated_at"
    )
    .order("updated_at", { ascending: false })
    .limit(limit)
    .returns<VideoSourceRow[]>();

  throwIfError(error);
  return data ?? [];
}

async function countRows(table: "video_sources" | "automation_jobs", filters?: (query: any) => any): Promise<number> {
  let query = supabase.from(table).select("*", { count: "exact", head: true });
  if (filters) {
    query = filters(query);
  }

  const { count, error } = await query;
  throwIfError(error);
  return count ?? 0;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const [
    totalSources,
    resolvedSources,
    unresolvedSources,
    activeJobs,
    failedJobs,
    completedJobs
  ] = await Promise.all([
    countRows("video_sources"),
    countRows("video_sources", (query) => query.eq("status", "resolved")),
    countRows("video_sources", (query) => query.eq("status", "unresolved")),
    countRows("automation_jobs", (query) => query.in("status", ACTIVE_AUTOMATION_STATUSES)),
    countRows("automation_jobs", (query) => query.eq("status", "failed")),
    countRows("automation_jobs", (query) => query.eq("status", "completed"))
  ]);

  return {
    totalSources,
    resolvedSources,
    unresolvedSources,
    activeJobs,
    failedJobs,
    completedJobs
  };
}
