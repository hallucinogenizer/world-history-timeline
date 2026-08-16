-- World History Timeline — backend schema.
-- One row per timeline, keyed by a secret UUID the app knows.
-- RLS is enabled with NO policies, so the anon/publishable role cannot touch
-- this table directly. Only the Edge Function's admin (secret-key) client can.

create table if not exists public.private_timeline (
  id uuid primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.private_timeline enable row level security;
