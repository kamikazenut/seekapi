import { env } from "./config";

interface SeekAdvancedUploadResponse {
  id?: string;
  data?: {
    id?: string;
  };
}

interface SeekAdvancedUploadTaskResponse {
  id?: string;
  status?: string;
  error?: string;
  videos?: unknown[];
  data?: {
    id?: string;
    status?: string;
    error?: string;
    videos?: unknown[];
  };
}

interface SeekVideoResponse {
  id?: string;
  name?: string;
  resolution?: string;
  status?: string;
}

export interface SeekUploadTask {
  id: string;
}

export interface SeekUploadTaskDetail {
  id: string;
  status: string;
  error: string | null;
  videos: string[];
}

export interface SeekVideoDetail {
  id: string;
  name: string;
  resolution: string | null;
  status: string | null;
}

function ensureSeekConfigured(): void {
  if (!env.SEEK_API_TOKEN) {
    throw new Error("Seek API token is not configured.");
  }
}

async function seekRequest<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  ensureSeekConfigured();

  const url = `${env.SEEK_API_BASE.replace(/\/+$/, "")}${pathname}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "api-token": env.SEEK_API_TOKEN!,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {})
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Seek request failed (${response.status}): ${body}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export async function createSeekAdvancedUploadTask(url: string, name: string): Promise<SeekUploadTask> {
  const payload = await seekRequest<SeekAdvancedUploadResponse>("/api/v1/video/advance-upload", {
    method: "POST",
    body: JSON.stringify({ url, name })
  });

  const id = payload.id ?? payload.data?.id;
  if (!id) {
    throw new Error("Seek did not return an upload task id.");
  }

  return { id };
}

export async function getSeekAdvancedUploadTask(taskId: string): Promise<SeekUploadTaskDetail> {
  const payload = await seekRequest<SeekAdvancedUploadTaskResponse>(`/api/v1/video/advance-upload/${taskId}`);
  const root = payload.data ?? payload;
  const videos = Array.isArray(root.videos) ? root.videos.map((value) => String(value)) : [];

  return {
    id: root.id ?? taskId,
    status: root.status ?? "Unknown",
    error: root.error ?? null,
    videos
  };
}

export async function getSeekVideoDetail(videoId: string): Promise<SeekVideoDetail> {
  const payload = await seekRequest<SeekVideoResponse>(`/api/v1/video/manage/${videoId}`);
  return {
    id: payload.id ?? videoId,
    name: payload.name ?? videoId,
    resolution: payload.resolution ?? null,
    status: payload.status ?? null
  };
}
