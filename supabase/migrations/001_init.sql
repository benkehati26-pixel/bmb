-- BMB work log – schema, RLS, helpers. Idempotent.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9._-]{2,32}$'),
  display_name text not null default '',
  role text not null default 'user' check (role in ('admin','user')),
  ai_enabled boolean not null default true,
  disabled boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  date date not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, date)
);
create index if not exists logs_date_idx on public.logs(date);

create table if not exists public.app_settings (
  id int primary key default 1 check (id = 1),
  company_name text not null default '',
  logo jsonb,              -- {dataUrl,w,h} resized client-side (<~350KB)
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
insert into public.app_settings (id) values (1) on conflict do nothing;

create table if not exists public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  calls int not null default 0,
  primary key (user_id, day)
);

-- helpers (security definer so RLS policies don't recurse)
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin' and not disabled);
$$;
create or replace function public.is_active() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and not disabled);
$$;

-- login helper: username -> auth email (falls back to <username>@bmb.local in the client)
create or replace function public.login_email(p_username text) returns text
language sql stable security definer set search_path = public, auth as $$
  select u.email from public.profiles p join auth.users u on u.id = p.id
  where p.username = lower(trim(p_username)) and not p.disabled limit 1;
$$;

-- atomic per-user daily AI counter (service_role only)
create or replace function public.ai_bump(p_user uuid, p_limit int) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into public.ai_usage (user_id, day, calls) values (p_user, (now() at time zone 'Asia/Jerusalem')::date, 1)
  on conflict (user_id, day) do update set calls = ai_usage.calls + 1
  returning calls into n;
  return n;
end $$;

-- auto-create profile for new auth users (username from metadata or email local part)
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, display_name, role, ai_enabled)
  values (
    new.id,
    lower(coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1))),
    coalesce(new.raw_user_meta_data->>'display_name', ''),
    'user', coalesce((new.raw_user_meta_data->>'ai_enabled')::boolean, true)
  ) on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- logs.updated_at + immutable owner
create or replace function public.logs_touch() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then new.user_id := old.user_id; new.created_at := old.created_at; end if;
  if new.updated_at is null then new.updated_at := now(); end if;
  return new;
end $$;
drop trigger if exists logs_touch on public.logs;
create trigger logs_touch before insert or update on public.logs for each row execute function public.logs_touch();

-- RLS
alter table public.profiles enable row level security;
alter table public.logs enable row level security;
alter table public.app_settings enable row level security;
alter table public.ai_usage enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
-- no insert/update/delete policies on profiles: changes go through the admin-users edge function (service_role)

drop policy if exists logs_select on public.logs;
create policy logs_select on public.logs for select to authenticated
  using ((user_id = auth.uid() and public.is_active()) or public.is_admin());
drop policy if exists logs_insert on public.logs;
create policy logs_insert on public.logs for insert to authenticated
  with check (user_id = auth.uid() and public.is_active());
drop policy if exists logs_update on public.logs;
create policy logs_update on public.logs for update to authenticated
  using (user_id = auth.uid() and public.is_active()) with check (user_id = auth.uid());
drop policy if exists logs_delete on public.logs;
create policy logs_delete on public.logs for delete to authenticated
  using (user_id = auth.uid() and public.is_active());

drop policy if exists settings_select on public.app_settings;
create policy settings_select on public.app_settings for select to authenticated using (public.is_active());
drop policy if exists settings_update on public.app_settings;
create policy settings_update on public.app_settings for update to authenticated
  using (public.is_admin()) with check (public.is_admin() and id = 1);

drop policy if exists ai_usage_select on public.ai_usage;
create policy ai_usage_select on public.ai_usage for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- grants
revoke all on public.profiles, public.logs, public.app_settings, public.ai_usage from anon;
grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.logs to authenticated;
grant select, update on public.app_settings to authenticated;
grant select on public.ai_usage to authenticated;
revoke execute on function public.ai_bump(uuid, int) from public, anon, authenticated;
grant execute on function public.ai_bump(uuid, int) to service_role;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
grant execute on function public.login_email(text) to anon, authenticated;
grant execute on function public.is_admin(), public.is_active() to authenticated;
