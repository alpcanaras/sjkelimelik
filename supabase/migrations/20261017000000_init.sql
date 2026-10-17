-- SJ Kelimelik schema.
-- Reads: seasons, matches and player usernames are public; real names are members-only;
-- accounts and the audit log are visible to their owner and admins.
-- Writes: no table accepts direct writes from the API. Every change goes through the
-- security-definer functions below, which check the caller's identity and role.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
grant usage on schema private to anon, authenticated;

-- ---------------------------------------------------------------- usernames
-- Mirrors usernameKey / validUsername in src/engine.js.
create or replace function public.username_key(name text) returns text
language sql immutable set search_path = '' as $$
  select lower(translate(name, 'ÇĞİÖŞÜçğıöşü', 'CGIOSUcgiosu'))
$$;

create or replace function public.valid_username(name text) returns boolean
language sql immutable set search_path = '' as $$
  select name ~ '^[A-Za-z0-9ÇĞİÖŞÜçğıöşü_.]{3,20}$' and name !~ '(^\.|\.$|\.\.)'
$$;

-- ---------------------------------------------------------------- tables
create table public.players (
  id uuid primary key default gen_random_uuid(),
  username text not null check (public.valid_username(username)),
  username_key text generated always as (public.username_key(username)) stored unique,
  created_at timestamptz not null default now()
);

create table public.player_private (
  player_id uuid primary key references public.players on delete cascade,
  real_name text check (char_length(real_name) between 1 and 80)
);

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  username text not null check (public.valid_username(username)),
  username_key text generated always as (public.username_key(username)) stored unique,
  real_name text check (char_length(real_name) between 1 and 80),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  is_admin boolean not null default false,
  player_id uuid unique references public.players on delete set null,
  created_at timestamptz not null default now()
);

create table public.seasons (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 3 and 70),
  format text not null check (format in ('league', 'cup')),
  status text not null default 'live' check (status in ('live', 'finished')),
  stage text not null check (stage in ('league', 'groups', 'knockout')),
  legs int not null default 2 check (legs in (1, 2)),
  seed_strategy text check (seed_strategy in ('pots', 'bands', 'random')),
  player_ids uuid[] not null,
  groups jsonb not null default '[]',
  bracket jsonb,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles on delete set null
);

create table public.matches (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.seasons on delete cascade,
  phase text not null check (phase in ('league', 'group', 'knockout')),
  group_id text,
  round int not null,
  leg int,
  slot int,
  player_a uuid references public.players,
  player_b uuid references public.players,
  status text not null check (status in ('scheduled', 'pending', 'disputed', 'done', 'waiting')),
  score_a int check (score_a between 0 and 9999),
  score_b int check (score_b between 0 and 9999),
  pending_a int check (pending_a between 0 and 9999),
  pending_b int check (pending_b between 0 and 9999),
  pending_by uuid references public.players,
  submitted_by uuid references public.profiles on delete set null,
  confirmed_by uuid references public.profiles on delete set null,
  finalized_at timestamptz,
  updated_at timestamptz not null default now(),
  check (status <> 'done' or (score_a is not null and score_b is not null)),
  check (phase <> 'knockout' or status <> 'done' or score_a <> score_b)
);
create index matches_season_idx on public.matches (season_id);
create unique index matches_knockout_slot on public.matches (season_id, round, slot) where phase = 'knockout';

create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid,
  actor_name text,
  action text not null
);

-- ---------------------------------------------------------------- helpers (not exposed through the API)
create or replace function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid() and status = 'approved'), false)
$$;

create or replace function private.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and status = 'approved')
$$;

create or replace function private.my_player_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select player_id from public.profiles where id = auth.uid() and status = 'approved'
$$;

create or replace function private.require_admin() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'Bu işlem için yönetici yetkisi gerekiyor.'; end if;
end $$;

create or replace function private.log(what text) returns void
language sql security definer set search_path = '' as $$
  insert into public.audit_log (actor, actor_name, action)
  values (auth.uid(), (select username from public.profiles where id = auth.uid()), what)
$$;

create or replace function private.player_name(p uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select username from public.players where id = p), '?')
$$;

create or replace function private.match_label(m public.matches) returns text
language sql stable security definer set search_path = '' as $$
  select private.player_name(m.player_a) || ' - ' || private.player_name(m.player_b)
$$;

create or replace function private.check_scores(phase text, a int, b int) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if a is null or b is null or a < 0 or b < 0 or a > 9999 or b > 9999 then
    raise exception '0 ile 9999 arasında tam sayı girin.';
  end if;
  if phase = 'knockout' and a = b then raise exception 'Eleme maçlarında beraberlik olamaz.'; end if;
end $$;

-- Re-derives knockout participants from finished matches, clearing any later match whose
-- pairing changed (e.g. after an admin correction). Same rules as the original demo.
create or replace function private.rebuild_bracket(p_season uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  rounds int;
  m public.matches;
  wa uuid;
  wb uuid;
  final_done boolean;
begin
  select round(log(2, (bracket->>'size')::numeric))::int into rounds from public.seasons where id = p_season;
  if rounds is null then return; end if;
  for r in 1 .. rounds - 1 loop
    for m in select * from public.matches where season_id = p_season and phase = 'knockout' and round = r order by slot loop
      select case when status = 'done' then case when score_a > score_b then player_a else player_b end end into wa
        from public.matches where season_id = p_season and phase = 'knockout' and round = r - 1 and slot = m.slot * 2;
      select case when status = 'done' then case when score_a > score_b then player_a else player_b end end into wb
        from public.matches where season_id = p_season and phase = 'knockout' and round = r - 1 and slot = m.slot * 2 + 1;
      if m.player_a is distinct from wa or m.player_b is distinct from wb then
        update public.matches set player_a = wa, player_b = wb, score_a = null, score_b = null,
          pending_a = null, pending_b = null, pending_by = null, submitted_by = null, confirmed_by = null,
          finalized_at = null, updated_at = now(),
          status = case when wa is not null and wb is not null then 'scheduled' else 'waiting' end
        where id = m.id;
      elsif wa is not null and wb is not null and m.status = 'waiting' then
        update public.matches set status = 'scheduled', updated_at = now() where id = m.id;
      end if;
    end loop;
  end loop;
  select coalesce(bool_and(status = 'done'), false) into final_done
    from public.matches where season_id = p_season and phase = 'knockout' and round = rounds - 1;
  update public.seasons set status = case when final_done then 'finished' else 'live' end where id = p_season;
end $$;

create or replace function private.after_result(p_season uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.seasons;
begin
  select * into s from public.seasons where id = p_season;
  if s.bracket is not null then
    perform private.rebuild_bracket(p_season);
  elsif s.format = 'league' then
    update public.seasons set status = case
      when exists (select 1 from public.matches where season_id = p_season and status <> 'done') then 'live' else 'finished' end
    where id = p_season;
  end if;
end $$;

-- One-time bootstrap, run from the Supabase SQL editor after signing up in the app:
--   select private.make_admin('your_username');
create or replace function private.make_admin(p_username text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  pr public.profiles;
  pid uuid;
begin
  select * into pr from public.profiles where username_key = public.username_key(p_username);
  if not found then raise exception 'Hesap bulunamadı: %', p_username; end if;
  pid := coalesce(pr.player_id, (select id from public.players where username_key = pr.username_key));
  if pid is null then
    insert into public.players (username) values (pr.username) returning id into pid;
  end if;
  if pr.real_name is not null then
    insert into public.player_private (player_id, real_name) values (pid, pr.real_name)
    on conflict (player_id) do update set real_name = excluded.real_name;
  end if;
  update public.profiles set is_admin = true, status = 'approved', player_id = pid where id = pr.id;
end $$;

-- Helpers run inside the security-definer functions; only the two used by RLS policies are
-- callable by API roles (the private schema itself is never exposed through the API).
revoke execute on all functions in schema private from public;
grant execute on function private.is_admin(), private.is_member() to anon, authenticated;

-- ---------------------------------------------------------------- new accounts
-- The app signs up with email "<username_key>@<AUTH_EMAIL_DOMAIN>" and the username in metadata.
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare uname text := new.raw_user_meta_data->>'username';
begin
  if uname is null or not public.valid_username(uname) then
    raise exception 'Geçersiz kullanıcı adı.';
  end if;
  if split_part(new.email, '@', 1) <> public.username_key(uname) then
    raise exception 'Kullanıcı adı ile giriş anahtarı uyuşmuyor.';
  end if;
  insert into public.profiles (id, username, real_name)
  values (new.id, uname, nullif(left(trim(new.raw_user_meta_data->>'real_name'), 80), ''));
  return new;
end $$;

revoke execute on function private.handle_new_user() from public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant usage on schema private to supabase_auth_admin;
    grant execute on function private.handle_new_user() to supabase_auth_admin;
  end if;
end $$;

-- ---------------------------------------------------------------- row level security
alter table public.players enable row level security;
alter table public.player_private enable row level security;
alter table public.profiles enable row level security;
alter table public.seasons enable row level security;
alter table public.matches enable row level security;
alter table public.audit_log enable row level security;

create policy "players are public" on public.players for select to anon, authenticated using (true);
create policy "real names for members" on public.player_private for select to authenticated using (private.is_member());
create policy "own profile or admin" on public.profiles for select to authenticated using (id = auth.uid() or private.is_admin());
create policy "seasons are public" on public.seasons for select to anon, authenticated using (true);
create policy "matches are public" on public.matches for select to anon, authenticated using (true);
create policy "audit log for admins" on public.audit_log for select to authenticated using (private.is_admin());

-- ---------------------------------------------------------------- player actions
create or replace function public.submit_score(p_match uuid, p_a int, p_b int) returns void
language plpgsql security definer set search_path = '' as $$
declare
  m public.matches;
  me uuid := private.my_player_id();
begin
  select * into m from public.matches where id = p_match for update;
  if not found then raise exception 'Maç bulunamadı.'; end if;
  perform private.check_scores(m.phase, p_a, p_b);
  if me is null then raise exception 'Hesabınız henüz onaylanmadı veya bir oyuncuya bağlı değil.'; end if;
  if me is distinct from m.player_a and me is distinct from m.player_b then
    raise exception 'Yalnızca kendi maçınız için sonuç girebilirsiniz.';
  end if;
  if m.status <> 'scheduled' then raise exception 'Bu maç şu anda sonuç girişine açık değil.'; end if;
  update public.matches set status = 'pending', pending_a = p_a, pending_b = p_b, pending_by = me,
    submitted_by = auth.uid(), updated_at = now()
  where id = p_match;
  perform private.log(private.match_label(m) || ' sonucu onaya gönderildi (' || p_a || ' : ' || p_b || ')');
end $$;

-- The opponent (or an admin) accepts or disputes a pending result.
create or replace function public.respond_score(p_match uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  m public.matches;
  me uuid := private.my_player_id();
  admin boolean := private.is_admin();
begin
  select * into m from public.matches where id = p_match for update;
  if not found then raise exception 'Maç bulunamadı.'; end if;
  if m.status <> 'pending' then raise exception 'Onay bekleyen sonuç bulunamadı.'; end if;
  if not admin and (me is null or (me is distinct from m.player_a and me is distinct from m.player_b) or me = m.pending_by) then
    raise exception 'Sonucu yalnızca rakibiniz veya yönetici onaylayabilir.';
  end if;
  if p_accept then
    update public.matches set status = 'done', score_a = pending_a, score_b = pending_b,
      pending_a = null, pending_b = null, pending_by = null, confirmed_by = auth.uid(),
      finalized_at = coalesce(finalized_at, now()), updated_at = now()
    where id = p_match;
    perform private.log(private.match_label(m) || ' sonucu onaylandı');
    perform private.after_result(m.season_id);
  else
    update public.matches set status = 'disputed', updated_at = now() where id = p_match;
    perform private.log(private.match_label(m) || ' sonucuna itiraz edildi');
  end if;
end $$;

create or replace function public.update_my_profile(p_real_name text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  clean text := nullif(left(trim(p_real_name), 80), '');
  pid uuid;
begin
  if auth.uid() is null then raise exception 'Giriş yapmanız gerekiyor.'; end if;
  update public.profiles set real_name = clean where id = auth.uid() returning player_id into pid;
  if pid is not null then
    insert into public.player_private (player_id, real_name) values (pid, clean)
    on conflict (player_id) do update set real_name = excluded.real_name;
  end if;
end $$;

-- ---------------------------------------------------------------- admin: results
create or replace function public.admin_set_score(p_match uuid, p_a int, p_b int) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.matches;
begin
  perform private.require_admin();
  select * into m from public.matches where id = p_match for update;
  if not found then raise exception 'Maç bulunamadı.'; end if;
  if m.player_a is null or m.player_b is null then raise exception 'Bu eşleşme henüz belirlenmedi.'; end if;
  perform private.check_scores(m.phase, p_a, p_b);
  update public.matches set status = 'done', score_a = p_a, score_b = p_b,
    pending_a = null, pending_b = null, pending_by = null,
    submitted_by = auth.uid(), confirmed_by = auth.uid(),
    finalized_at = coalesce(finalized_at, now()), updated_at = now()
  where id = p_match;
  perform private.log(private.match_label(m) || ' sonucu yönetici tarafından kaydedildi (' || p_a || ' : ' || p_b || ')');
  perform private.after_result(m.season_id);
end $$;

create or replace function public.admin_reset_match(p_match uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.matches;
begin
  perform private.require_admin();
  select * into m from public.matches where id = p_match for update;
  if not found then raise exception 'Maç bulunamadı.'; end if;
  update public.matches set score_a = null, score_b = null, pending_a = null, pending_b = null, pending_by = null,
    submitted_by = null, confirmed_by = null, finalized_at = null, updated_at = now(),
    status = case when player_a is not null and player_b is not null then 'scheduled' else 'waiting' end
  where id = p_match;
  perform private.log(private.match_label(m) || ' sonucu sıfırlandı');
  perform private.after_result(m.season_id);
end $$;

-- ---------------------------------------------------------------- admin: seasons
-- Fixtures and groups are planned in the browser by src/engine.js (planSeason) and stored here.
-- p: {name, format, legs, seed_strategy, stage, player_ids:[uuid], groups:[{id,name,players}],
--     matches:[{phase, group_id, round, leg, slot, a, b}]}
create or replace function public.admin_create_season(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  sid uuid;
  ids uuid[];
  n int;
begin
  perform private.require_admin();
  select array_agg(distinct x::uuid) into ids from jsonb_array_elements_text(p->'player_ids') x;
  if coalesce(array_length(ids, 1), 0) < 4 then raise exception 'Lütfen en az 4 oyuncu seçin.'; end if;
  if (select count(*) from public.players where id = any(ids)) <> array_length(ids, 1) then
    raise exception 'Seçilen oyunculardan biri bulunamadı.';
  end if;
  insert into public.seasons (name, format, stage, legs, seed_strategy, player_ids, groups, created_by)
  values (trim(p->>'name'), p->>'format', case when p->>'format' = 'cup' then 'groups' else 'league' end, coalesce((p->>'legs')::int, 2),
          nullif(p->>'seed_strategy', ''), ids, coalesce(p->'groups', '[]'), auth.uid())
  returning id into sid;
  insert into public.matches (season_id, phase, group_id, round, leg, slot, player_a, player_b, status)
  select sid, x.phase, x.group_id, x.round, x.leg, x.slot, x.a, x.b, 'scheduled'
  from jsonb_to_recordset(p->'matches') as x(phase text, group_id text, round int, leg int, slot int, a uuid, b uuid);
  get diagnostics n = row_count;
  if n = 0 then raise exception 'Fikstür boş.'; end if;
  if exists (select 1 from public.matches where season_id = sid
             and (player_a is null or player_b is null or player_a = player_b
                  or not (player_a = any(ids)) or not (player_b = any(ids)))) then
    raise exception 'Fikstürde sezona kayıtlı olmayan bir oyuncu var.';
  end if;
  perform private.log(trim(p->>'name') || ' oluşturuldu, ' || array_length(ids, 1) || ' katılımcı, ' || n || ' maç');
  return sid;
end $$;

-- p: {bracket:{size, qualifiers, snapshot}, matches:[{round, slot, a, b}]} from planKnockout.
create or replace function public.admin_create_knockout(p_season uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  s public.seasons;
  size int := (p->'bracket'->>'size')::int;
  n int;
begin
  perform private.require_admin();
  select * into s from public.seasons where id = p_season for update;
  if not found then raise exception 'Sezon bulunamadı.'; end if;
  if s.format <> 'cup' or s.stage <> 'groups' then raise exception 'Bu aşamada eleme oluşturulamaz.'; end if;
  if exists (select 1 from public.matches where season_id = p_season and phase = 'group' and status <> 'done') then
    raise exception 'Tüm grup maçları sonuçlanmadan eleme eşleşmeleri oluşturulamaz.';
  end if;
  if size is null or size < 2 or (size & (size - 1)) <> 0 then raise exception 'Geçersiz eleme tablosu boyutu.'; end if;
  insert into public.matches (season_id, phase, round, slot, player_a, player_b, status)
  select p_season, 'knockout', x.round, x.slot, x.a, x.b,
         case when x.a is not null and x.b is not null then 'scheduled' else 'waiting' end
  from jsonb_to_recordset(p->'matches') as x(round int, slot int, a uuid, b uuid);
  get diagnostics n = row_count;
  if n <> size - 1 then raise exception 'Eleme tablosu eksik.'; end if;
  if exists (select 1 from public.matches where season_id = p_season and phase = 'knockout'
             and ((player_a is not null and not (player_a = any(s.player_ids)))
               or (player_b is not null and not (player_b = any(s.player_ids))))) then
    raise exception 'Eleme tablosunda sezona kayıtlı olmayan bir oyuncu var.';
  end if;
  update public.seasons set stage = 'knockout', bracket = p->'bracket' where id = p_season;
  perform private.log(s.name || ': son ' || size || ' eleme tablosu oluşturuldu');
end $$;

create or replace function public.admin_delete_season(p_season uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare nm text;
begin
  perform private.require_admin();
  delete from public.seasons where id = p_season returning name into nm;
  if nm is null then raise exception 'Sezon bulunamadı.'; end if;
  perform private.log(nm || ' silindi');
end $$;

-- ---------------------------------------------------------------- admin: people
-- Approves an account. With p_player it is linked to that existing (admin-created) player;
-- otherwise it claims the unlinked player with the same username, or a new player is created.
create or replace function public.approve_profile(p_profile uuid, p_player uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  pr public.profiles;
  pid uuid;
begin
  perform private.require_admin();
  select * into pr from public.profiles where id = p_profile for update;
  if not found then raise exception 'Hesap bulunamadı.'; end if;
  if pr.player_id is not null and pr.status = 'approved' then raise exception 'Bu hesap zaten onaylı.'; end if;
  pid := coalesce(p_player, (select id from public.players where username_key = pr.username_key));
  if pid is not null then
    if not exists (select 1 from public.players where id = pid) then raise exception 'Oyuncu bulunamadı.'; end if;
    if exists (select 1 from public.profiles where player_id = pid and id <> p_profile) then
      raise exception 'Bu oyuncu başka bir hesaba bağlı.';
    end if;
  else
    insert into public.players (username) values (pr.username) returning id into pid;
  end if;
  if pr.real_name is not null then
    insert into public.player_private (player_id, real_name) values (pid, pr.real_name)
    on conflict (player_id) do update set real_name = excluded.real_name;
  end if;
  update public.profiles set status = 'approved', player_id = pid where id = p_profile;
  perform private.log(pr.username || ' hesabı onaylandı');
end $$;

create or replace function public.reject_profile(p_profile uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare nm text;
begin
  perform private.require_admin();
  if p_profile = auth.uid() then raise exception 'Kendi hesabınızı reddedemezsiniz.'; end if;
  update public.profiles set status = 'rejected', is_admin = false, player_id = null
  where id = p_profile returning username into nm;
  if nm is null then raise exception 'Hesap bulunamadı.'; end if;
  perform private.log(nm || ' hesabı reddedildi');
end $$;

-- A player without an account (e.g. someone who never logs in, or past seasons' players).
create or replace function public.admin_add_player(p_username text, p_real_name text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  pid uuid;
  clean text := nullif(left(trim(p_real_name), 80), '');
begin
  perform private.require_admin();
  if not public.valid_username(p_username) then raise exception 'Geçersiz kullanıcı adı.'; end if;
  if exists (select 1 from public.players where username_key = public.username_key(p_username)) then
    raise exception 'Bu kullanıcı adıyla bir oyuncu zaten var.';
  end if;
  insert into public.players (username) values (p_username) returning id into pid;
  if clean is not null then insert into public.player_private (player_id, real_name) values (pid, clean); end if;
  perform private.log(p_username || ' oyuncu olarak eklendi');
  return pid;
end $$;

create or replace function public.admin_set_admin(p_profile uuid, p_value boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare nm text;
begin
  perform private.require_admin();
  if not p_value and p_profile = auth.uid() then raise exception 'Kendi yönetici yetkinizi kaldıramazsınız.'; end if;
  update public.profiles set is_admin = p_value where id = p_profile and status = 'approved' returning username into nm;
  if nm is null then raise exception 'Onaylı hesap bulunamadı.'; end if;
  perform private.log(nm || case when p_value then ' yönetici yapıldı' else ' yöneticilikten çıkarıldı' end);
end $$;

-- There is no email to send a reset link to, so admins set a new password directly.
create or replace function public.admin_reset_password(p_profile uuid, p_password text) returns void
language plpgsql security definer set search_path = '' as $$
declare nm text;
begin
  perform private.require_admin();
  if char_length(coalesce(p_password, '')) < 8 then raise exception 'Şifre en az 8 karakter olmalı.'; end if;
  select username into nm from public.profiles where id = p_profile;
  if nm is null then raise exception 'Hesap bulunamadı.'; end if;
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now()
  where id = p_profile;
  perform private.log(nm || ' için şifre sıfırlandı');
end $$;

-- ---------------------------------------------------------------- function privileges
-- Supabase grants execute on new public functions to anon by default. Player and admin
-- actions require a signed-in user; the checks inside each function do the rest.
do $$
declare f text;
begin
  foreach f in array array[
    'submit_score(uuid,int,int)', 'respond_score(uuid,boolean)', 'update_my_profile(text)',
    'admin_set_score(uuid,int,int)', 'admin_reset_match(uuid)', 'admin_create_season(jsonb)',
    'admin_create_knockout(uuid,jsonb)', 'admin_delete_season(uuid)', 'approve_profile(uuid,uuid)',
    'reject_profile(uuid)', 'admin_add_player(text,text)', 'admin_set_admin(uuid,boolean)',
    'admin_reset_password(uuid,text)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ---------------------------------------------------------------- crest storage
-- Public bucket for the crest (kept out of the public repo). Upload it as branding/crest.png.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('branding', 'branding', true) on conflict (id) do nothing;
  end if;
end $$;

-- ---------------------------------------------------------------- live updates
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.matches, public.seasons, public.players;
  end if;
end $$;
