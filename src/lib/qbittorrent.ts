import { env } from "./config";

interface QbTorrentInfo {
  hash?: string;
  name?: string;
  state?: string;
  tags?: string;
  category?: string;
  added_on?: number;
}

export interface QbittorrentSubmission {
  hash: string | null;
  jobTag: string;
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function ensureQbittorrentConfigured(): void {
  if (!env.QBITTORRENT_BASE_URL || !env.QBITTORRENT_USERNAME || !env.QBITTORRENT_PASSWORD) {
    throw new Error("qBittorrent is not configured.");
  }
}

function qbittorrentBaseUrl(): string {
  return env.QBITTORRENT_BASE_URL!.replace(/\/+$/, "");
}

function qbittorrentOrigin(): string {
  return new URL(env.QBITTORRENT_BASE_URL!).origin;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function parseConfiguredTags(): string[] {
  return (env.QBITTORRENT_TAGS ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function normalizeInfoHash(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  if (/^[a-f0-9]{40}$/i.test(normalized)) {
    return normalized.toLowerCase();
  }

  if (/^[a-z2-7]{32}$/i.test(normalized)) {
    const hex = base32ToHex(normalized);
    return hex && /^[a-f0-9]{40}$/i.test(hex) ? hex.toLowerCase() : normalized.toLowerCase();
  }

  return normalized.toLowerCase();
}

function base32ToHex(input: string): string | null {
  let bits = "";

  for (const char of input.replace(/=+$/g, "").toUpperCase()) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value === -1) {
      return null;
    }

    bits += value.toString(2).padStart(5, "0");
  }

  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }

  return bytes.length ? Buffer.from(bytes).toString("hex") : null;
}

function extractMagnetInfoHash(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "magnet:") {
      return null;
    }

    for (const value of parsed.searchParams.getAll("xt")) {
      const match = value.match(/^urn:btih:(.+)$/i);
      if (match) {
        return normalizeInfoHash(match[1]);
      }
    }
  } catch {
    return null;
  }

  return null;
}

function hasTag(tags: string | undefined, expectedTag: string): boolean {
  return (tags ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .includes(expectedTag);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function getCookieHeader(response: Response): string | null {
  const multiHeader = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  const candidates = multiHeader.length > 0 ? multiHeader : [response.headers.get("set-cookie") ?? ""];

  for (const candidate of candidates) {
    const match = candidate.match(/(?:^|;\s*)SID=([^;]+)/i) ?? candidate.match(/\bSID=([^;]+)/i);
    if (match) {
      return `SID=${match[1]}`;
    }
  }

  return null;
}

async function loginQbittorrent(): Promise<string> {
  ensureQbittorrentConfigured();

  const response = await fetch(`${qbittorrentBaseUrl()}/api/v2/auth/login`, {
    method: "POST",
    headers: {
      Accept: "text/plain",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Origin: qbittorrentOrigin(),
      Referer: `${trimSlash(env.QBITTORRENT_BASE_URL!)}/`
    },
    body: new URLSearchParams({
      username: env.QBITTORRENT_USERNAME!,
      password: env.QBITTORRENT_PASSWORD!
    })
  });

  const body = (await response.text()).trim();
  if (!response.ok || !/^ok\.?$/i.test(body)) {
    throw new Error(`qBittorrent login failed (${response.status}): ${body || "Unknown error"}`);
  }

  const cookie = getCookieHeader(response);
  if (!cookie) {
    throw new Error("qBittorrent login succeeded but no SID cookie was returned.");
  }

  return cookie;
}

async function qbittorrentRequest<T>(pathname: string, cookie: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${qbittorrentBaseUrl()}${pathname}`, {
    ...init,
    headers: {
      Accept: "application/json,text/plain,*/*",
      Cookie: cookie,
      Origin: qbittorrentOrigin(),
      Referer: `${trimSlash(env.QBITTORRENT_BASE_URL!)}/`,
      ...(init.headers ?? {})
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`qBittorrent request failed (${response.status}): ${body}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function listTorrents(cookie: string): Promise<QbTorrentInfo[]> {
  const torrents = await qbittorrentRequest<QbTorrentInfo[]>(`/api/v2/torrents/info?filter=all`, cookie);
  return Array.isArray(torrents) ? torrents : [];
}

async function waitForTorrentHash(cookie: string, jobTag: string): Promise<string | null> {
  const deadline = Date.now() + env.QBITTORRENT_DISCOVERY_TIMEOUT_MS;

  while (Date.now() <= deadline) {
    const torrents = await listTorrents(cookie);
    const tagged = torrents
      .filter((torrent) => hasTag(torrent.tags, jobTag))
      .sort((left, right) => (right.added_on ?? 0) - (left.added_on ?? 0));

    const hash = normalizeInfoHash(tagged[0]?.hash);
    if (hash) {
      return hash;
    }

    await delay(env.QBITTORRENT_DISCOVERY_POLL_MS);
  }

  return null;
}

export async function submitTorrentToQbittorrent(jobId: string, torrentUrl: string): Promise<QbittorrentSubmission> {
  ensureQbittorrentConfigured();

  const cookie = await loginQbittorrent();
  const jobTag = `seekshare-job-${jobId}`;
  const tags = [...parseConfiguredTags(), jobTag];

  const form = new FormData();
  form.set("urls", torrentUrl);
  form.set("category", env.QBITTORRENT_CATEGORY);
  form.set("paused", env.QBITTORRENT_PAUSED ? "true" : "false");
  form.set("skip_checking", env.QBITTORRENT_SKIP_CHECKING ? "true" : "false");
  form.set("autoTMM", env.QBITTORRENT_AUTO_TMM ? "true" : "false");
  form.set("sequentialDownload", env.QBITTORRENT_SEQUENTIAL_DOWNLOAD ? "true" : "false");
  form.set("firstLastPiecePrio", env.QBITTORRENT_FIRST_LAST_PIECE_PRIO ? "true" : "false");

  if (env.QBITTORRENT_SAVE_PATH) {
    form.set("savepath", env.QBITTORRENT_SAVE_PATH);
  }

  if (tags.length > 0) {
    form.set("tags", tags.join(","));
  }

  const response = await fetch(`${qbittorrentBaseUrl()}/api/v2/torrents/add`, {
    method: "POST",
    headers: {
      Accept: "text/plain",
      Cookie: cookie,
      Origin: qbittorrentOrigin(),
      Referer: `${trimSlash(env.QBITTORRENT_BASE_URL!)}/`
    },
    body: form
  });

  const body = (await response.text()).trim();
  if (!response.ok || !/^ok\.?$/i.test(body)) {
    throw new Error(`qBittorrent add failed (${response.status}): ${body || "Unknown error"}`);
  }

  return {
    hash: extractMagnetInfoHash(torrentUrl) ?? (await waitForTorrentHash(cookie, jobTag)),
    jobTag
  };
}
