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

export function renderEmbedPage(params: EmbedPageParams): string {
  const title = escapeHtml(params.title);
  const siteName = escapeHtml(params.siteName);
  const subtitle = escapeHtml(params.subtitle);
  const description = escapeHtml(params.description ?? "No resolved stream is available yet.");
  const embedUrl = params.embedUrl ? escapeHtml(params.embedUrl) : null;

  if (embedUrl) {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${title} | ${siteName}</title>
    <style>
      :root {
        color-scheme: dark;
        background: #000;
      }
      * {
        box-sizing: border-box;
      }
      html,
      body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: #000;
      }
      body {
        position: fixed;
        inset: 0;
      }
      .frame {
        position: absolute;
        inset: 0;
        width: 100vw;
        height: 100vh;
        border: 0;
        display: block;
        background: #000;
      }
    </style>
  </head>
  <body>
    <iframe class="frame" src="${embedUrl}" title="${title}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="origin-when-cross-origin"></iframe>
  </body>
</html>`;
  }

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} | ${siteName}</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #06080c;
        --panel: #0d1219;
        --line: rgba(255, 255, 255, 0.08);
        --text: #f6f7fb;
        --muted: #9ba8ba;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        font-family: "Segoe UI", sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top, rgba(77, 123, 255, 0.12), transparent 28%),
          linear-gradient(180deg, #06080c, #090c12 58%, #06080c);
      }
      .panel {
        width: min(680px, 100%);
        padding: 28px;
        border: 1px solid var(--line);
        border-radius: 24px;
        background: rgba(13, 18, 25, 0.92);
        text-align: center;
      }
      h1 {
        margin: 0;
        font-size: clamp(28px, 4vw, 42px);
      }
      p {
        margin: 14px 0 0;
        line-height: 1.6;
        color: var(--muted);
      }
      .subtitle {
        font-size: 14px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
    </style>
  </head>
  <body>
    <main class="panel">
      <h1>${title}</h1>
      <p class="subtitle">${subtitle}</p>
      <p>${description}</p>
    </main>
  </body>
</html>`;
}
