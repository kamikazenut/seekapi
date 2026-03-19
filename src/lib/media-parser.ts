import path from "node:path";

import type { MediaGuess } from "./types";

const TV_PATTERNS = [
  /^(?<title>.+?)[\s._-]+s(?<season>\d{1,2})e(?<episode>\d{1,2})(?:e\d{1,2})?/i,
  /^(?<title>.+?)[\s._-]+(?<season>\d{1,2})x(?<episode>\d{1,2})/i
];

const STOP_TOKENS =
  /\b(4320p|2160p|1440p|1080p|720p|480p|8k|4k|uhd|bluray|bdrip|brrip|web(?:[-.\s]?dl|rip)?|hdrip|hdtv|dvdrip|remux|proper|repack|x264|x265|h\.?264|h\.?265|hevc|aac(?:2\.0)?|ddp?(?:5\.1|7\.1)?|atmos|10bit|dv|hdr|amzn|nf|dsnp|hmax|rarbg|yts|torrentgalaxy|etrg)\b/i;

const YEAR_PATTERN = /\b(19|20)\d{2}\b/;
const RESOLUTION_PATTERN = /\b(4320p|2160p|1440p|1080p|720p|480p|8k|4k|uhd)\b/i;

function stripExtension(input: string): string {
  return input.replace(/\.[a-z0-9]{2,4}$/i, "");
}

function normalizeSpaces(input: string): string {
  return input
    .replace(/[._]+/g, " ")
    .replace(/[\[\]{}()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleize(input: string): string {
  const normalized = normalizeSpaces(input);
  if (!normalized) {
    return normalized;
  }

  return normalized
    .split(" ")
    .map((part) => {
      if (/^[ivxlcdm]+$/i.test(part)) {
        return part.toUpperCase();
      }

      if (part.length <= 3 && /^[A-Z0-9]+$/i.test(part) && part === part.toUpperCase()) {
        return part.toUpperCase();
      }

      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join(" ");
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())).map((value) => value.trim()))];
}

function normalizeResolution(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized === "4k" || normalized === "uhd") {
    return "2160p";
  }

  if (normalized === "8k") {
    return "4320p";
  }

  return normalized;
}

function extractResolution(...inputs: string[]): string | undefined {
  for (const input of inputs) {
    const match = input.match(RESOLUTION_PATTERN);
    if (match) {
      return normalizeResolution(match[1]);
    }
  }

  return undefined;
}

function extractYear(input: string): number | undefined {
  const match = input.match(YEAR_PATTERN);
  return match ? Number(match[0]) : undefined;
}

function cleanMovieTitle(candidate: string): { title: string; year?: number } {
  const base = stripExtension(path.basename(candidate));
  const stopMatch = base.match(STOP_TOKENS);
  const yearMatch = base.match(YEAR_PATTERN);

  let cutIndex = base.length;

  if (stopMatch && typeof stopMatch.index === "number") {
    cutIndex = Math.min(cutIndex, stopMatch.index);
  }

  if (yearMatch && typeof yearMatch.index === "number") {
    cutIndex = Math.min(cutIndex, yearMatch.index);
  }

  let title = base.slice(0, cutIndex).trim();
  if (!title) {
    title = base;
  }

  return {
    title: titleize(title),
    year: extractYear(base)
  };
}

function parseTvCandidate(candidate: string) {
  const base = stripExtension(path.basename(candidate));
  for (const pattern of TV_PATTERNS) {
    const match = base.match(pattern);
    if (!match?.groups) {
      continue;
    }

    const rawTitle = match.groups.title ?? "";
    const seasonNumber = Number(match.groups.season);
    const episodeNumber = Number(match.groups.episode);

    if (!rawTitle || Number.isNaN(seasonNumber) || Number.isNaN(episodeNumber)) {
      continue;
    }

    return {
      title: titleize(rawTitle),
      year: extractYear(base),
      seasonNumber,
      episodeNumber
    };
  }

  return null;
}

export function extractMediaGuess(torrentName: string, contentPath: string): MediaGuess {
  const fileName = path.basename(contentPath);
  const candidates = unique([fileName, torrentName]);
  const resolution = extractResolution(fileName, torrentName);

  for (const candidate of candidates) {
    const parsedTv = parseTvCandidate(candidate);
    if (parsedTv) {
      return {
        type: "tv",
        title: parsedTv.title,
        searchTerms: unique([parsedTv.title, titleize(stripExtension(fileName)), titleize(torrentName)]),
        year: parsedTv.year,
        seasonNumber: parsedTv.seasonNumber,
        episodeNumber: parsedTv.episodeNumber,
        resolution,
        fileName,
        rawName: torrentName
      };
    }
  }

  const parsedMovie = cleanMovieTitle(fileName);
  const fallbackMovie = cleanMovieTitle(torrentName);

  return {
    type: "movie",
    title: parsedMovie.title || fallbackMovie.title,
    searchTerms: unique([parsedMovie.title, fallbackMovie.title]),
    year: parsedMovie.year ?? fallbackMovie.year,
    resolution,
    fileName,
    rawName: torrentName
  };
}
