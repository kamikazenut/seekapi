create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.media_titles (
  id uuid primary key default gen_random_uuid(),
  media_type text not null check (media_type in ('movie', 'tv')),
  tmdb_id integer not null,
  title text not null,
  original_title text,
  release_date date,
  poster_path text,
  backdrop_path text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (media_type, tmdb_id)
);

create table if not exists public.media_episodes (
  id uuid primary key default gen_random_uuid(),
  show_tmdb_id integer not null,
  season_number integer not null,
  episode_number integer not null,
  name text,
  air_date date,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (show_tmdb_id, season_number, episode_number)
);

create table if not exists public.video_sources (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('seekstream', 'bigshare')),
  provider_video_id text not null,
  embed_url text not null,
  torrent_hash text,
  torrent_name text not null,
  content_path text not null,
  media_type text check (media_type in ('movie', 'tv')),
  tmdb_id integer,
  season_number integer,
  episode_number integer,
  guessed_title text,
  guessed_year integer,
  resolution text,
  file_name text,
  status text not null default 'resolved' check (status in ('resolved', 'unresolved')),
  callback_payload jsonb not null default '{}'::jsonb,
  tmdb_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_video_id),
  constraint video_sources_scope_check check (
    media_type is null
    or (
      media_type = 'movie'
      and season_number is null
      and episode_number is null
    )
    or (
      media_type = 'tv'
      and season_number is not null
      and episode_number is not null
    )
  )
);

create table if not exists public.automation_jobs (
  id uuid primary key default gen_random_uuid(),
  media_type text not null check (media_type in ('movie', 'tv')),
  tmdb_id integer not null,
  season_number integer,
  episode_number integer,
  status text not null default 'queued' check (status in ('queued', 'searching', 'submitting', 'polling', 'downloading', 'completed', 'failed')),
  trigger_source text not null default 'embed',
  attempt_count integer not null default 0,
  release_title text,
  release_guid text,
  release_link text,
  seek_task_id text,
  seek_video_ids jsonb,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint automation_jobs_scope_check check (
    (
      media_type = 'movie'
      and season_number is null
      and episode_number is null
    )
    or (
      media_type = 'tv'
      and season_number is not null
      and episode_number is null
    )
    or (
      media_type = 'tv'
      and season_number is not null
      and episode_number is not null
    )
  )
);

create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
declare
  existing_status_constraint text;
begin
  select conname
    into existing_status_constraint
  from pg_constraint
  where conrelid = 'public.automation_jobs'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%status%'
  limit 1;

  if existing_status_constraint is not null then
    execute format('alter table public.automation_jobs drop constraint if exists %I', existing_status_constraint);
  end if;
exception
  when undefined_table then
    null;
end;
$$;

alter table public.automation_jobs
  drop constraint if exists automation_jobs_status_check;

alter table public.automation_jobs
  add constraint automation_jobs_status_check
  check (status in ('queued', 'searching', 'submitting', 'polling', 'downloading', 'completed', 'failed'));

alter table public.automation_jobs
  drop constraint if exists automation_jobs_scope_check;

alter table public.automation_jobs
  add constraint automation_jobs_scope_check
  check (
    (
      media_type = 'movie'
      and season_number is null
      and episode_number is null
    )
    or (
      media_type = 'tv'
      and season_number is not null
      and episode_number is null
    )
    or (
      media_type = 'tv'
      and season_number is not null
      and episode_number is not null
    )
  );

create index if not exists media_titles_lookup_idx
  on public.media_titles (media_type, tmdb_id);

create index if not exists media_episodes_lookup_idx
  on public.media_episodes (show_tmdb_id, season_number, episode_number);

create index if not exists video_sources_movie_lookup_idx
  on public.video_sources (media_type, tmdb_id, updated_at desc);

create index if not exists video_sources_episode_lookup_idx
  on public.video_sources (media_type, tmdb_id, season_number, episode_number, updated_at desc);

create index if not exists video_sources_status_idx
  on public.video_sources (status);

create index if not exists automation_jobs_due_idx
  on public.automation_jobs (status, next_attempt_at);

create index if not exists app_settings_updated_at_idx
  on public.app_settings (updated_at desc);

drop index if exists automation_jobs_active_unique_idx;

create unique index if not exists automation_jobs_active_unique_idx
  on public.automation_jobs (
    media_type,
    tmdb_id,
    coalesce(season_number, -1),
    coalesce(episode_number, -1)
  )
  where status in ('queued', 'searching', 'submitting', 'polling', 'downloading');

drop trigger if exists media_titles_set_updated_at on public.media_titles;
create trigger media_titles_set_updated_at
before update on public.media_titles
for each row execute function public.set_updated_at();

drop trigger if exists media_episodes_set_updated_at on public.media_episodes;
create trigger media_episodes_set_updated_at
before update on public.media_episodes
for each row execute function public.set_updated_at();

drop trigger if exists video_sources_set_updated_at on public.video_sources;
create trigger video_sources_set_updated_at
before update on public.video_sources
for each row execute function public.set_updated_at();

drop trigger if exists automation_jobs_set_updated_at on public.automation_jobs;
create trigger automation_jobs_set_updated_at
before update on public.automation_jobs
for each row execute function public.set_updated_at();

drop trigger if exists app_settings_set_updated_at on public.app_settings;
create trigger app_settings_set_updated_at
before update on public.app_settings
for each row execute function public.set_updated_at();
