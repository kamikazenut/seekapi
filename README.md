# SeekShare API

This service rebuilds the old MySQL embed API as a Supabase-backed Node app.

It does four jobs:

1. Accept callback payloads from `dood_upload.sh`
2. Resolve movies and TV episodes against TMDB
3. Store provider sources in Supabase
4. Serve `/embed/movie/:tmdbId` and `/embed/tv/:tmdbId/:season/:episode`

It also includes a dashboard and automatic acquisition flow.

It now also includes a TMDB auto-grabber. When enabled from the dashboard, the service periodically scans TMDB popular pages and queues jobs by itself:

- movie auto-grabber: popular released movies
- season-pack auto-grabber: the latest aired regular season for popular TV shows

The default automation pipeline is:

1. TMDB id requested from the dashboard or an `/embed/...` miss
2. TMDB title/episode metadata loaded and cached
3. Jackett searched with TMDB-derived names
4. qBittorrent on the Ultra server receives the best release
5. qBittorrent finishes and runs `dood_upload.sh`
6. `dood_upload.sh` uploads to Bigshare and SeekStreaming
7. Callbacks return to this API and complete the job

`Jackett -> qBittorrent -> dood_upload.sh -> callback -> embed` is now the primary automatic path.

## Routes

- `GET /`
- `GET /dashboard`
- `POST /dashboard/actions/automation/movie`
- `POST /dashboard/actions/automation/season`
- `POST /dashboard/actions/automation/tv`
- `GET /healthz`
- `POST /v1/automation/movie/:tmdbId`
- `POST /v1/automation/tv/:tmdbId/:season`
- `POST /v1/automation/tv/:tmdbId/:season/:episode`
- `GET /v1/automation/jobs/:jobId`
- `POST /v1/callbacks/seekstream`
- `POST /v1/callbacks/bigshare`
- `GET /embed/movie/:tmdbId`
- `GET /embed/tv/:tmdbId/:season/:episode`

## What Changed

- Jackett TV lookups no longer fail just because an indexer rejects `tmdbid`. The app now falls back to title-based TV queries automatically.
- Season-pack jobs are now supported in the dashboard and API, and callback matching can map each file from a season pack back to the correct episode.
- Automation can hand releases to qBittorrent instead of pushing them straight into Seek.
- Callback matching now links back to queued jobs by torrent hash when available, which is much more reliable for TV episodes.
- Adult filtering is stricter for obvious porn/XXX releases and still blocks TMDB titles marked as adult.
- `dood_upload.sh` now supports an optional callback token without changing its current behavior when the token is blank.

## Setup

1. Reapply [`supabase/schema.sql`](/C:/Users/mrgli/Desktop/seekshare%20api/supabase/schema.sql) in Supabase.

This matters even if you already ran an older version. The SQL now updates the `automation_jobs` status constraint, season-job scope, active-job index, and creates the `app_settings` table used by dashboard toggles.

2. Copy [.env.example](/C:/Users/mrgli/Desktop/seekshare%20api/.env.example) to `.env` and fill the values you actually use.

Required for the default qBittorrent pipeline:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TMDB_API_KEY` or `TMDB_READ_ACCESS_TOKEN`
- `JACKETT_BASE_URL`
- `JACKETT_API_KEY`
- `QBITTORRENT_BASE_URL`
- `QBITTORRENT_USERNAME`
- `QBITTORRENT_PASSWORD`

3. Keep qBittorrent configured to run [`dood_upload.sh`](/C:/Users/mrgli/Desktop/seekshare%20api/dood_upload.sh) when a torrent completes.

The script should continue passing:

- `FILE_INPUT`
- `TORRENT_NAME`
- `TORRENT_HASH`

4. If this API uses callback auth, set the same token in both places:

- `CALLBACK_AUTH_TOKEN` in `.env`
- `CALLBACK_AUTH_TOKEN` near the top of [`dood_upload.sh`](/C:/Users/mrgli/Desktop/seekshare%20api/dood_upload.sh)

5. Install and run:

```bash
npm install
npm run dev
```

## Environment

Core:

- `PORT`
- `SITE_NAME`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TMDB_API_KEY`
- `TMDB_READ_ACCESS_TOKEN`
- `SEEK_EMBED_BASE_URL`
- `CALLBACK_AUTH_TOKEN`

Jackett:

- `JACKETT_BASE_URL`
- `JACKETT_API_KEY`
- `JACKETT_INDEXER`
- `JACKETT_MIN_SEEDERS`
- `JACKETT_MIN_PEERS`
- `JACKETT_MAX_SIZE_GB`
- `JACKETT_MAX_RESOLUTION`

qBittorrent automation:

- `QBITTORRENT_BASE_URL`
- `QBITTORRENT_USERNAME`
- `QBITTORRENT_PASSWORD`
- `QBITTORRENT_CATEGORY`
- `QBITTORRENT_TAGS`
- `QBITTORRENT_SAVE_PATH`
- `QBITTORRENT_PAUSED`
- `QBITTORRENT_SKIP_CHECKING`
- `QBITTORRENT_AUTO_TMM`
- `QBITTORRENT_SEQUENTIAL_DOWNLOAD`
- `QBITTORRENT_FIRST_LAST_PIECE_PRIO`
- `QBITTORRENT_DISCOVERY_TIMEOUT_MS`
- `QBITTORRENT_DISCOVERY_POLL_MS`

Automation:

- `AUTOMATION_DELIVERY_MODE`
  - `qbittorrent` is the default and uses the Ultra/qBittorrent completion hook
  - `seek` keeps the older direct Seek advanced-upload path
- `AUTOMATION_ENABLED`
- `AUTOMATION_AUTO_MOVIES`
- `AUTOMATION_AUTO_SEASON_PACKS`
- `AUTO_GRAB_INTERVAL_MS`
- `AUTO_GRAB_MOVIE_PAGES`
- `AUTO_GRAB_TV_PAGES`
- `AUTO_GRAB_REQUEUE_HOURS`
- `AUTOMATION_POLL_INTERVAL_MS`
- `AUTOMATION_RETRY_MINUTES`
- `AUTOMATION_MAX_ATTEMPTS`

Seek direct mode only:

- `SEEK_API_BASE`
- `SEEK_API_TOKEN`

Content safety:

- `ADULT_FILTER_ENABLED`
- `ADULT_BLOCKLIST`

## Notes

- The dashboard is server-rendered in the same Express app. There is no separate frontend build.
- `seekstream` remains the preferred provider on embed pages, with `bigshare` as fallback.
- The callback route accepts either `Authorization: Bearer <token>` or `x-callback-token` when callback auth is enabled.
- If TMDB is not configured, unresolved callbacks are still stored, but `/embed/...` pages will not be able to resolve them automatically.
- The movie and season-pack toggle buttons in the dashboard persist in Supabase via `app_settings`, so they survive restarts.
