interface EmbedPageParams {
  siteName: string;
  title: string;
  subtitle: string;
  description?: string;
  embedUrl?: string | null;
  provider?: string | null;
  resolution?: string | null;
  posterPath?: string | null;
  backdropPath?: string | null;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function tmdbImageUrl(path: string | null | undefined, size: string): string | null {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : null;
}

export function renderEmbedPage(params: EmbedPageParams): string {
  const title = escapeHtml(params.title);
  const subtitle = escapeHtml(params.subtitle);
  const description = escapeHtml(params.description ?? "Automatically matched stream source");
  const siteName = escapeHtml(params.siteName);
  const provider = params.provider ? escapeHtml(params.provider) : null;
  const resolution = params.resolution ? escapeHtml(params.resolution) : null;
  const posterUrl = tmdbImageUrl(params.posterPath, "w342");
  const backdropUrl = tmdbImageUrl(params.backdropPath, "original");
  const embedUrl = params.embedUrl ? escapeHtml(params.embedUrl) : null;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} | ${siteName}</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0d1117;
        --panel: rgba(14, 19, 27, 0.82);
        --panel-strong: rgba(12, 15, 22, 0.94);
        --line: rgba(255, 255, 255, 0.1);
        --text: #f4efe5;
        --muted: #b9b2a3;
        --accent: #ffb14a;
        --accent-soft: rgba(255, 177, 74, 0.18);
        --shadow: 0 30px 80px rgba(0, 0, 0, 0.42);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Segoe UI", "Trebuchet MS", sans-serif;
        color: var(--text);
        background:
          linear-gradient(135deg, rgba(10, 13, 18, 0.95), rgba(23, 17, 12, 0.92)),
          ${backdropUrl ? `linear-gradient(180deg, rgba(8, 10, 14, 0.5), rgba(8, 10, 14, 0.92)), url('${backdropUrl}') center/cover fixed` : "radial-gradient(circle at top left, #17202a 0%, #0d1117 55%, #090b10 100%)"};
      }
      .noise {
        position: fixed;
        inset: 0;
        pointer-events: none;
        background-image:
          linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px);
        background-size: 36px 36px;
        mask-image: radial-gradient(circle at center, black, transparent 80%);
      }
      .shell {
        max-width: 1240px;
        margin: 0 auto;
        padding: 32px 18px 48px;
      }
      .hero {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(220px, 280px);
        gap: 20px;
        align-items: stretch;
      }
      .card {
        border: 1px solid var(--line);
        background: var(--panel);
        backdrop-filter: blur(18px);
        box-shadow: var(--shadow);
      }
      .copy {
        border-radius: 28px;
        padding: 28px;
      }
      .eyebrow {
        margin: 0 0 12px;
        color: var(--accent);
        letter-spacing: 0.14em;
        text-transform: uppercase;
        font-size: 12px;
      }
      h1 {
        margin: 0;
        font-size: clamp(30px, 4vw, 58px);
        line-height: 0.98;
        max-width: 12ch;
      }
      .subtitle {
        margin: 14px 0 0;
        color: var(--muted);
        font-size: 17px;
      }
      .description {
        margin: 16px 0 0;
        color: #ddd4c1;
        max-width: 62ch;
        line-height: 1.6;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 22px;
      }
      .chip {
        border: 1px solid var(--line);
        background: var(--accent-soft);
        border-radius: 999px;
        padding: 8px 12px;
        font-size: 13px;
        color: #ffe8c1;
      }
      .poster {
        border-radius: 28px;
        overflow: hidden;
        min-height: 340px;
        background:
          linear-gradient(180deg, rgba(255, 177, 74, 0.22), rgba(255, 177, 74, 0)),
          #121820;
      }
      .poster img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .player {
        margin-top: 22px;
        border-radius: 30px;
        overflow: hidden;
        border: 1px solid var(--line);
        background: var(--panel-strong);
        box-shadow: var(--shadow);
      }
      .frame {
        aspect-ratio: 16 / 9;
        width: 100%;
        border: 0;
        display: block;
        background: #05070b;
      }
      .missing {
        min-height: min(52vw, 480px);
        display: grid;
        place-items: center;
        padding: 32px;
        text-align: center;
      }
      .missing strong {
        display: block;
        font-size: 28px;
        margin-bottom: 10px;
      }
      .missing span {
        color: var(--muted);
        max-width: 48ch;
        line-height: 1.6;
      }
      @media (max-width: 900px) {
        .hero {
          grid-template-columns: 1fr;
        }
        .poster {
          min-height: 200px;
        }
        .copy {
          padding: 22px;
        }
      }
    </style>
  </head>
  <body>
    <div class="noise"></div>
    <main class="shell">
      <section class="hero">
        <article class="card copy">
          <p class="eyebrow">${siteName}</p>
          <h1>${title}</h1>
          <p class="subtitle">${subtitle}</p>
          <p class="description">${description}</p>
          <div class="chips">
            ${provider ? `<span class="chip">Source: ${provider}</span>` : ""}
            ${resolution ? `<span class="chip">${resolution}</span>` : ""}
          </div>
        </article>
        <aside class="card poster">
          ${posterUrl ? `<img src="${posterUrl}" alt="${title} poster" loading="eager" />` : ""}
        </aside>
      </section>
      <section class="player">
        ${
          embedUrl
            ? `<iframe class="frame" src="${embedUrl}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="origin-when-cross-origin"></iframe>`
            : `<div class="missing"><div><strong>No stream matched yet</strong><span>The TMDB page exists, but there is no resolved provider entry for this title in Supabase yet.</span></div></div>`
        }
      </section>
    </main>
  </body>
</html>`;
}
