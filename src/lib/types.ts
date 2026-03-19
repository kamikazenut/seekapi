export type MediaType = "movie" | "tv";
export type Provider = "seekstream" | "bigshare";
export type AutomationJobStatus = "queued" | "searching" | "submitting" | "polling" | "downloading" | "completed" | "failed";

export interface UploadCallbackPayload {
  torrentHash?: string;
  torrentName: string;
  contentPath: string;
  fileCode: string;
  embedUrl?: string;
}

export interface MediaGuess {
  type: MediaType;
  title: string;
  searchTerms: string[];
  year?: number;
  seasonNumber?: number;
  episodeNumber?: number;
  resolution?: string;
  fileName: string;
  rawName: string;
}

export interface TmdbTitleRecord {
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  originalTitle?: string | null;
  releaseDate?: string | null;
  posterPath?: string | null;
  backdropPath?: string | null;
  metadata: Record<string, unknown>;
}

export interface TmdbEpisodeRecord {
  showTmdbId: number;
  seasonNumber: number;
  episodeNumber: number;
  name?: string | null;
  airDate?: string | null;
  metadata: Record<string, unknown>;
}

export interface ResolvedMediaMatch {
  title: TmdbTitleRecord;
  episode?: TmdbEpisodeRecord;
  score: number;
}

export interface CachedTitleRow {
  media_type: MediaType;
  tmdb_id: number;
  title: string;
  original_title: string | null;
  release_date: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  metadata: Record<string, unknown> | null;
}

export interface CachedEpisodeRow {
  show_tmdb_id: number;
  season_number: number;
  episode_number: number;
  name: string | null;
  air_date: string | null;
  metadata: Record<string, unknown> | null;
}

export interface VideoSourceRow {
  id: string;
  provider: Provider;
  provider_video_id: string;
  embed_url: string;
  torrent_hash: string | null;
  torrent_name: string;
  content_path: string;
  media_type: MediaType | null;
  tmdb_id: number | null;
  season_number: number | null;
  episode_number: number | null;
  guessed_title: string | null;
  guessed_year: number | null;
  resolution: string | null;
  file_name: string | null;
  status: "resolved" | "unresolved";
  callback_payload: Record<string, unknown> | null;
  tmdb_payload: Record<string, unknown> | null;
  updated_at: string;
}

export interface AutomationTarget {
  mediaType: MediaType;
  tmdbId: number;
  seasonNumber?: number;
  episodeNumber?: number;
}

export interface AutomationJobRow {
  id: string;
  media_type: MediaType;
  tmdb_id: number;
  season_number: number | null;
  episode_number: number | null;
  status: AutomationJobStatus;
  trigger_source: string;
  attempt_count: number;
  release_title: string | null;
  release_guid: string | null;
  release_link: string | null;
  seek_task_id: string | null;
  seek_video_ids: string[] | null;
  last_error: string | null;
  next_attempt_at: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface DashboardStats {
  totalSources: number;
  resolvedSources: number;
  unresolvedSources: number;
  activeJobs: number;
  failedJobs: number;
  completedJobs: number;
}

export interface AutomationModeSettings {
  moviesEnabled: boolean;
  seasonPacksEnabled: boolean;
}

export interface AutoGrabberStatus {
  running: boolean;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastQueuedMovies: number;
  lastQueuedSeasonPacks: number;
  lastError: string | null;
  intervalMs: number;
}
