import "dotenv/config";

import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  SITE_NAME: z.string().min(1).default("SeekShare"),
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  TMDB_API_KEY: z.string().min(1).optional(),
  TMDB_READ_ACCESS_TOKEN: z.string().min(1).optional(),
  SEEK_EMBED_BASE_URL: z.url().default("https://321movies.embedseek.xyz/#"),
  CALLBACK_AUTH_TOKEN: z.string().min(1).optional(),
  JACKETT_BASE_URL: z.url().optional(),
  JACKETT_API_KEY: z.string().min(1).optional(),
  JACKETT_INDEXER: z.string().min(1).default("all"),
  JACKETT_MIN_SEEDERS: z.coerce.number().int().nonnegative().default(8),
  JACKETT_MIN_PEERS: z.coerce.number().int().nonnegative().default(8),
  JACKETT_MAX_SIZE_GB: z.coerce.number().positive().default(15),
  JACKETT_MAX_RESOLUTION: z.enum(["480p", "720p", "1080p", "1440p", "2160p", "4320p"]).default("1080p"),
  QBITTORRENT_BASE_URL: z.url().optional(),
  QBITTORRENT_USERNAME: z.string().min(1).optional(),
  QBITTORRENT_PASSWORD: z.string().min(1).optional(),
  QBITTORRENT_CATEGORY: z.string().min(1).default("seekshare"),
  QBITTORRENT_TAGS: z.string().optional(),
  QBITTORRENT_SAVE_PATH: z.string().min(1).optional(),
  QBITTORRENT_PAUSED: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  QBITTORRENT_SKIP_CHECKING: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  QBITTORRENT_AUTO_TMM: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  QBITTORRENT_SEQUENTIAL_DOWNLOAD: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  QBITTORRENT_FIRST_LAST_PIECE_PRIO: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  QBITTORRENT_DISCOVERY_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  QBITTORRENT_DISCOVERY_POLL_MS: z.coerce.number().int().positive().default(2000),
  SEEK_API_BASE: z.url().default("https://seekstreaming.com"),
  SEEK_API_TOKEN: z.string().min(1).optional(),
  AUTOMATION_DELIVERY_MODE: z.enum(["qbittorrent", "seek"]).default("qbittorrent"),
  AUTOMATION_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value !== "false"),
  AUTOMATION_AUTO_MOVIES: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value !== "false"),
  AUTOMATION_AUTO_SEASON_PACKS: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  AUTO_GRAB_INTERVAL_MS: z.coerce.number().int().positive().default(3600000),
  AUTO_GRAB_MOVIE_PAGES: z.coerce.number().int().positive().default(3),
  AUTO_GRAB_TV_PAGES: z.coerce.number().int().positive().default(3),
  AUTO_GRAB_TV_SEASON_DELAY_MS: z.coerce.number().int().nonnegative().default(60000),
  AUTO_GRAB_REQUEUE_HOURS: z.coerce.number().int().positive().default(24),
  AUTOMATION_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
  AUTOMATION_RETRY_MINUTES: z.coerce.number().int().positive().default(30),
  AUTOMATION_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
  ADULT_FILTER_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value !== "false"),
  ADULT_BLOCKLIST: z.string().optional()
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    const json = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function classifySupabaseKey(key: string): "service_role" | "secret" | "publishable" | "anon" | "unknown" {
  if (key.startsWith("sb_secret_")) {
    return "secret";
  }

  if (key.startsWith("sb_publishable_")) {
    return "publishable";
  }

  const payload = decodeJwtPayload(key);
  if (!payload || typeof payload.role !== "string") {
    return "unknown";
  }

  if (payload.role === "service_role") {
    return "service_role";
  }

  if (payload.role === "anon" || payload.role === "authenticated") {
    return "anon";
  }

  return "unknown";
}

const supabaseKeyKind = classifySupabaseKey(parsed.data.SUPABASE_SERVICE_ROLE_KEY);
if (supabaseKeyKind === "publishable" || supabaseKeyKind === "anon") {
  console.error(
    "SUPABASE_SERVICE_ROLE_KEY is using a non-privileged key. Use the Supabase service-role key or sb_secret key, not the anon/publishable key."
  );
  process.exit(1);
}

export const env = parsed.data;
export const tmdbConfigured = Boolean(env.TMDB_API_KEY || env.TMDB_READ_ACCESS_TOKEN);
const qbittorrentAutomationConfigured = Boolean(
  env.QBITTORRENT_BASE_URL && env.QBITTORRENT_USERNAME && env.QBITTORRENT_PASSWORD
);
const seekAutomationConfigured = Boolean(env.SEEK_API_TOKEN);

export const automationConfigured =
  env.AUTOMATION_ENABLED &&
  Boolean(env.JACKETT_BASE_URL && env.JACKETT_API_KEY) &&
  (env.AUTOMATION_DELIVERY_MODE === "seek" ? seekAutomationConfigured : qbittorrentAutomationConfigured);

export const automationDeliveryLabel =
  env.AUTOMATION_DELIVERY_MODE === "seek" ? "Jackett to Seek" : "Jackett to qBittorrent";
