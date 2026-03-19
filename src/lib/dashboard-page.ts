import type { AutoGrabberStatus, AutomationJobRow, DashboardStats, VideoSourceRow } from "./types";

interface DashboardPageParams {
  siteName: string;
  automationEnabled: boolean;
  autoMovieEnabled: boolean;
  autoSeasonPackEnabled: boolean;
  autoGrabberStatus: AutoGrabberStatus;
  stats: DashboardStats;
  jobs: AutomationJobRow[];
  sources: VideoSourceRow[];
  notice?: string | null;
  error?: string | null;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(input: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(input));
  } catch {
    return input;
  }
}

function renderStatusBadge(status: string): string {
  const color =
    status === "completed" || status === "enabled"
      ? "good"
      : status === "failed" || status === "disabled"
        ? "bad"
        : status === "resolved"
          ? "good"
          : status === "unresolved"
            ? "warn"
            : "info";

  return `<span class="badge badge-${color}">${escapeHtml(status)}</span>`;
}

function renderJobTarget(job: AutomationJobRow): string {
  if (job.media_type === "movie") {
    return `movie:${job.tmdb_id}`;
  }

  if (job.episode_number === null) {
    return `tv:${job.tmdb_id} S${String(job.season_number ?? 0).padStart(2, "0")}`;
  }

  return `tv:${job.tmdb_id} S${String(job.season_number ?? 0).padStart(2, "0")}E${String(job.episode_number ?? 0).padStart(2, "0")}`;
}

function renderEmbedHref(source: VideoSourceRow): string | null {
  if (!source.tmdb_id || !source.media_type) {
    return null;
  }

  if (source.media_type === "movie") {
    return `/embed/movie/${source.tmdb_id}`;
  }

  if (source.season_number && source.episode_number) {
    return `/embed/tv/${source.tmdb_id}/${source.season_number}/${source.episode_number}`;
  }

  return null;
}

function renderFlash(kind: "notice" | "error", message: string | null | undefined): string {
  if (!message) {
    return "";
  }

  return `<div class="flash flash-${kind}">${escapeHtml(message)}</div>`;
}

function renderStatCard(label: string, value: number, tone: "neutral" | "good" | "warn" | "bad" = "neutral"): string {
  return `<article class="stat-card tone-${tone}">
    <span>${escapeHtml(label)}</span>
    <strong>${value}</strong>
  </article>`;
}

function formatInterval(intervalMs: number): string {
  if (intervalMs % (60 * 60 * 1000) === 0) {
    const hours = intervalMs / (60 * 60 * 1000);
    return `Every ${hours}h`;
  }

  if (intervalMs % (60 * 1000) === 0) {
    const minutes = intervalMs / (60 * 1000);
    return `Every ${minutes}m`;
  }

  return `Every ${Math.round(intervalMs / 1000)}s`;
}

function renderToggleForm(params: { mode: "movies" | "season-packs"; enabled: boolean; label: string }): string {
  const nextEnabled = !params.enabled;
  return `<div class="toggle-row">
    <div class="toggle-copy">
      <strong>${escapeHtml(params.label)}</strong>
      <span>Current state: ${params.enabled ? "Enabled" : "Disabled"}</span>
    </div>
    ${renderStatusBadge(params.enabled ? "enabled" : "disabled")}
    <form action="/dashboard/actions/settings/automation-mode" method="post">
    <input type="hidden" name="mode" value="${params.mode}" />
    <input type="hidden" name="enabled" value="${nextEnabled ? "true" : "false"}" />
    <button type="submit">${nextEnabled ? `Enable ${escapeHtml(params.label)}` : `Disable ${escapeHtml(params.label)}`}</button>
    </form>
  </div>`;
}

function renderJobRows(jobs: AutomationJobRow[]): string {
  if (jobs.length === 0) {
    return `<tr><td colspan="7" class="empty">No automation jobs yet.</td></tr>`;
  }

  return jobs
    .map((job) => {
      const embedHref =
        job.media_type === "movie"
          ? `/embed/movie/${job.tmdb_id}`
          : job.episode_number === null
            ? null
            : `/embed/tv/${job.tmdb_id}/${job.season_number}/${job.episode_number}`;

      return `<tr>
        <td>${embedHref ? `<a href="${embedHref}" target="_blank" rel="noreferrer">${escapeHtml(renderJobTarget(job))}</a>` : escapeHtml(renderJobTarget(job))}</td>
        <td>${renderStatusBadge(job.status)}</td>
        <td>${escapeHtml(job.trigger_source)}</td>
        <td>${job.attempt_count}</td>
        <td>${escapeHtml(job.release_title ?? "-")}</td>
        <td>${escapeHtml(job.last_error ?? "-")}</td>
        <td>
          <div>${escapeHtml(formatDate(job.updated_at))}</div>
          <a href="/v1/automation/jobs/${job.id}" target="_blank" rel="noreferrer">JSON</a>
        </td>
      </tr>`;
    })
    .join("");
}

function renderSourceRows(sources: VideoSourceRow[]): string {
  if (sources.length === 0) {
    return `<tr><td colspan="7" class="empty">No sources stored yet.</td></tr>`;
  }

  return sources
    .map((source) => {
      const embedHref = renderEmbedHref(source);
      const target =
        source.media_type === "movie"
          ? `movie:${source.tmdb_id ?? "-"}`
          : source.tmdb_id && source.season_number && source.episode_number
            ? `tv:${source.tmdb_id} S${String(source.season_number).padStart(2, "0")}E${String(source.episode_number).padStart(2, "0")}`
            : "unmatched";

      return `<tr>
        <td>${escapeHtml(source.provider)}</td>
        <td>${renderStatusBadge(source.status)}</td>
        <td>${embedHref ? `<a href="${embedHref}" target="_blank" rel="noreferrer">${escapeHtml(target)}</a>` : escapeHtml(target)}</td>
        <td>${escapeHtml(source.file_name ?? source.torrent_name)}</td>
        <td>${escapeHtml(source.resolution ?? "-")}</td>
        <td><a href="${escapeHtml(source.embed_url)}" target="_blank" rel="noreferrer">player</a></td>
        <td>${escapeHtml(formatDate(source.updated_at))}</td>
      </tr>`;
    })
    .join("");
}

export function renderDashboardPage(params: DashboardPageParams): string {
  const title = escapeHtml(params.siteName);
  const automationState = params.automationEnabled ? "Enabled" : "Disabled";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} Dashboard</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0a1116;
        --panel: rgba(12, 21, 28, 0.88);
        --panel-2: rgba(17, 29, 38, 0.92);
        --line: rgba(255, 255, 255, 0.08);
        --text: #f3efe6;
        --muted: #9fb0b8;
        --accent: #f18c45;
        --teal: #73d6c2;
        --warn: #f5c05f;
        --bad: #ee6d73;
        --good: #6bd489;
        --shadow: 0 25px 60px rgba(0, 0, 0, 0.36);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        color: var(--text);
        font-family: Georgia, "Trebuchet MS", serif;
        background:
          radial-gradient(circle at top left, rgba(115, 214, 194, 0.08), transparent 28%),
          radial-gradient(circle at top right, rgba(241, 140, 69, 0.14), transparent 30%),
          linear-gradient(180deg, #0a1116 0%, #091017 44%, #0c151d 100%);
      }
      a { color: #ffd9bf; text-decoration: none; }
      a:hover { text-decoration: underline; }
      .shell {
        max-width: 1380px;
        margin: 0 auto;
        padding: 28px 18px 44px;
      }
      .masthead {
        display: grid;
        grid-template-columns: minmax(0, 1.5fr) minmax(280px, 0.8fr);
        gap: 18px;
        margin-bottom: 18px;
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 28px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(16px);
      }
      .hero {
        padding: 30px;
      }
      .eyebrow {
        margin: 0 0 12px;
        color: var(--teal);
        letter-spacing: 0.18em;
        text-transform: uppercase;
        font-size: 12px;
      }
      h1 {
        margin: 0;
        font-size: clamp(36px, 5vw, 70px);
        line-height: 0.95;
        max-width: 9ch;
      }
      .lead {
        margin: 16px 0 0;
        max-width: 62ch;
        line-height: 1.6;
        color: #d7d6d2;
      }
      .quick {
        padding: 24px;
        display: grid;
        align-content: start;
        gap: 16px;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        padding: 9px 14px;
        border-radius: 999px;
        border: 1px solid var(--line);
        width: fit-content;
        background: rgba(255, 255, 255, 0.03);
      }
      .dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: ${params.automationEnabled ? "var(--good)" : "var(--bad)"};
        box-shadow: 0 0 20px ${params.automationEnabled ? "rgba(107, 212, 137, 0.45)" : "rgba(238, 109, 115, 0.4)"};
      }
      .stats {
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        gap: 14px;
        margin-bottom: 18px;
      }
      .stat-card {
        padding: 18px 20px;
        border-radius: 22px;
        border: 1px solid var(--line);
        background: var(--panel-2);
      }
      .stat-card span {
        display: block;
        font-size: 12px;
        color: var(--muted);
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .stat-card strong {
        display: block;
        margin-top: 10px;
        font-size: 34px;
        line-height: 1;
      }
      .tone-good strong { color: var(--good); }
      .tone-warn strong { color: var(--warn); }
      .tone-bad strong { color: var(--bad); }
      .layout {
        display: grid;
        grid-template-columns: minmax(320px, 380px) minmax(0, 1fr);
        gap: 18px;
      }
      .stack {
        display: grid;
        gap: 18px;
      }
      .section {
        padding: 22px;
      }
      .section h2 {
        margin: 0 0 8px;
        font-size: 24px;
      }
      .section p {
        margin: 0;
        color: var(--muted);
        line-height: 1.55;
      }
      .flash {
        border-radius: 18px;
        padding: 14px 16px;
        margin-bottom: 14px;
        border: 1px solid var(--line);
      }
      .flash-notice {
        background: rgba(107, 212, 137, 0.12);
        color: #dff9e6;
      }
      .flash-error {
        background: rgba(238, 109, 115, 0.12);
        color: #ffd7d9;
      }
      .form-grid {
        display: grid;
        gap: 14px;
        margin-top: 18px;
      }
      label {
        display: grid;
        gap: 8px;
        font-size: 13px;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      input {
        width: 100%;
        padding: 13px 14px;
        border-radius: 16px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.04);
        color: var(--text);
        font: inherit;
      }
      .inline-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
      }
      .toggle-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 12px;
        align-items: center;
        padding: 14px;
        border-radius: 18px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.03);
      }
      .toggle-copy {
        display: grid;
        gap: 6px;
      }
      .toggle-copy strong {
        font-size: 15px;
      }
      .toggle-copy span {
        color: var(--muted);
        font-size: 13px;
      }
      button {
        appearance: none;
        border: 0;
        border-radius: 16px;
        padding: 14px 16px;
        font: inherit;
        color: #111;
        background: linear-gradient(135deg, #ffd39a, #f18c45);
        cursor: pointer;
      }
      button:hover {
        filter: brightness(1.03);
      }
      .meta-list {
        display: grid;
        gap: 10px;
        margin-top: 18px;
      }
      .meta-item {
        display: flex;
        justify-content: space-between;
        gap: 14px;
        padding: 12px 14px;
        border-radius: 16px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.03);
      }
      .table-card {
        overflow: hidden;
      }
      .table-head {
        padding: 22px 22px 0;
      }
      .table-wrap {
        overflow-x: auto;
        padding: 0 10px 10px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        min-width: 860px;
      }
      th, td {
        padding: 14px 12px;
        text-align: left;
        border-bottom: 1px solid var(--line);
        vertical-align: top;
        font-size: 14px;
      }
      th {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        padding: 6px 10px;
        border-radius: 999px;
        font-size: 12px;
        border: 1px solid transparent;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .badge-good {
        background: rgba(107, 212, 137, 0.12);
        color: #d6f7df;
        border-color: rgba(107, 212, 137, 0.2);
      }
      .badge-bad {
        background: rgba(238, 109, 115, 0.14);
        color: #ffd6d8;
        border-color: rgba(238, 109, 115, 0.25);
      }
      .badge-warn {
        background: rgba(245, 192, 95, 0.14);
        color: #ffedc6;
        border-color: rgba(245, 192, 95, 0.24);
      }
      .badge-info {
        background: rgba(115, 214, 194, 0.14);
        color: #d8faf4;
        border-color: rgba(115, 214, 194, 0.24);
      }
      .empty {
        color: var(--muted);
        text-align: center;
      }
      .footer-note {
        margin-top: 18px;
        color: var(--muted);
        font-size: 13px;
      }
      .actions-row {
        display: grid;
        gap: 12px;
      }
      @media (max-width: 1200px) {
        .stats {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
      }
      @media (max-width: 980px) {
        .masthead, .layout {
          grid-template-columns: 1fr;
        }
        .stats {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      @media (max-width: 640px) {
        .shell {
          padding: 18px 12px 30px;
        }
        .hero, .quick, .section {
          padding: 18px;
        }
        .stats {
          grid-template-columns: 1fr;
        }
        .inline-grid {
          grid-template-columns: 1fr;
        }
        .toggle-row {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      ${renderFlash("notice", params.notice)}
      ${renderFlash("error", params.error)}
      <section class="masthead">
        <article class="card hero">
          <p class="eyebrow">${title}</p>
          <h1>Automation Dashboard</h1>
          <p class="lead">Manual trigger controls on the left, automatic Jackett jobs on the right. Missing embed pages can auto-queue, and this screen lets you inspect or force the same workflow directly.</p>
        </article>
        <aside class="card quick">
          <div class="pill"><span class="dot"></span><strong>${escapeHtml(automationState)}</strong></div>
          <div class="meta-list">
            <div class="meta-item"><span>Auto queue on embed miss</span><strong>${params.automationEnabled ? "On" : "Off"}</strong></div>
            <div class="meta-item"><span>Movie auto mode</span><strong>${params.autoMovieEnabled ? "On" : "Off"}</strong></div>
            <div class="meta-item"><span>Season-pack auto mode</span><strong>${params.autoSeasonPackEnabled ? "On" : "Off"}</strong></div>
            <div class="meta-item"><span>Manual movie trigger</span><strong>POST + form</strong></div>
            <div class="meta-item"><span>Manual TV trigger</span><strong>POST + form</strong></div>
            <div class="meta-item"><span>Refresh</span><a href="/dashboard">Reload</a></div>
          </div>
        </aside>
      </section>

      <section class="stats">
        ${renderStatCard("Total Sources", params.stats.totalSources)}
        ${renderStatCard("Resolved", params.stats.resolvedSources, "good")}
        ${renderStatCard("Unresolved", params.stats.unresolvedSources, "warn")}
        ${renderStatCard("Active Jobs", params.stats.activeJobs, "warn")}
        ${renderStatCard("Completed Jobs", params.stats.completedJobs, "good")}
        ${renderStatCard("Failed Jobs", params.stats.failedJobs, "bad")}
      </section>

      <section class="layout">
        <div class="stack">
          <article class="card section">
            <h2>Auto Grabber</h2>
            <p>These toggles control the background TMDB grabber. When enabled, the service scans TMDB popular pages and queues jobs without anyone having to open an embed route first.</p>
            <div class="form-grid">
              ${renderToggleForm({ mode: "movies", enabled: params.autoMovieEnabled, label: "Movie Auto Grabber" })}
              ${renderToggleForm({ mode: "season-packs", enabled: params.autoSeasonPackEnabled, label: "Season-Pack Auto Grabber" })}
              <div class="actions-row">
                <form action="/dashboard/actions/automation/run-now" method="post">
                  <button type="submit">Run Auto Grabber Now</button>
                </form>
                <div class="meta-list">
                  <div class="meta-item"><span>Worker state</span><strong>${params.autoGrabberStatus.running ? "Running" : "Idle"}</strong></div>
                  <div class="meta-item"><span>Last started</span><strong>${params.autoGrabberStatus.lastStartedAt ? escapeHtml(formatDate(params.autoGrabberStatus.lastStartedAt)) : "Never"}</strong></div>
                  <div class="meta-item"><span>Last finished</span><strong>${params.autoGrabberStatus.lastFinishedAt ? escapeHtml(formatDate(params.autoGrabberStatus.lastFinishedAt)) : "Never"}</strong></div>
                  <div class="meta-item"><span>Last queued</span><strong>${params.autoGrabberStatus.lastQueuedMovies} movies / ${params.autoGrabberStatus.lastQueuedSeasonPacks} seasons</strong></div>
                  <div class="meta-item"><span>Interval</span><strong>${escapeHtml(formatInterval(params.autoGrabberStatus.intervalMs))}</strong></div>
                  <div class="meta-item"><span>Last error</span><strong>${escapeHtml(params.autoGrabberStatus.lastError ?? "None")}</strong></div>
                </div>
              </div>
            </div>
          </article>

          <article class="card section">
            <h2>Manual Movie Trigger</h2>
            <p>Queue a movie job by TMDB id. This uses the same Jackett automation path as the automatic embed miss flow.</p>
            <form class="form-grid" action="/dashboard/actions/automation/movie" method="post">
              <label>
                TMDB Movie Id
                <input type="number" min="1" name="tmdbId" placeholder="603" required />
              </label>
              <button type="submit">Queue Movie Automation</button>
            </form>
          </article>

          <article class="card section">
            <h2>Manual Season Trigger</h2>
            <p>Queue a season-pack job by TMDB show id and season. This is the fastest way to pull a whole season through qBittorrent and let callbacks map each episode automatically.</p>
            <form class="form-grid" action="/dashboard/actions/automation/season" method="post">
              <div class="inline-grid">
                <label>
                  TMDB Show Id
                  <input type="number" min="1" name="tmdbId" placeholder="1399" required />
                </label>
                <label>
                  Season
                  <input type="number" min="1" name="season" placeholder="1" required />
                </label>
              </div>
              <button type="submit">Queue Season Automation</button>
            </form>
          </article>

          <article class="card section">
            <h2>Manual TV Trigger</h2>
            <p>Queue a TV episode job by TMDB id, season, and episode.</p>
            <form class="form-grid" action="/dashboard/actions/automation/tv" method="post">
              <div class="inline-grid">
                <label>
                  TMDB Show Id
                  <input type="number" min="1" name="tmdbId" placeholder="1399" required />
                </label>
                <label>
                  Season
                  <input type="number" min="1" name="season" placeholder="1" required />
                </label>
                <label>
                  Episode
                  <input type="number" min="1" name="episode" placeholder="1" required />
                </label>
              </div>
              <button type="submit">Queue Episode Automation</button>
            </form>
          </article>

          <article class="card section">
            <h2>Auto Notes</h2>
            <p>Automatic mode is driven by the embed routes. Movie misses respect the movie auto toggle. TV episode misses can either queue a single episode job or, when season-pack auto mode is on, queue a whole-season job instead.</p>
            <p class="footer-note">This dashboard is server-rendered inside the same Node service, so there is no separate frontend build step.</p>
          </article>
        </div>

        <div class="stack">
          <article class="card table-card">
            <div class="table-head section">
              <h2>Recent Automation Jobs</h2>
              <p>Newest job activity first, including auto-triggered embed misses and manual dashboard submissions.</p>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Target</th>
                    <th>Status</th>
                    <th>Trigger</th>
                    <th>Attempts</th>
                    <th>Release</th>
                    <th>Last Error</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  ${renderJobRows(params.jobs)}
                </tbody>
              </table>
            </div>
          </article>

          <article class="card table-card">
            <div class="table-head section">
              <h2>Recent Sources</h2>
              <p>Newest stored provider rows, including both callback-ingested and automation-created entries.</p>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Status</th>
                    <th>Target</th>
                    <th>File</th>
                    <th>Resolution</th>
                    <th>Embed</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  ${renderSourceRows(params.sources)}
                </tbody>
              </table>
            </div>
          </article>
        </div>
      </section>
    </main>
  </body>
</html>`;
}
