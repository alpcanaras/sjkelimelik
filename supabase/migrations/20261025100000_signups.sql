-- Season registration with a deadline: members click join / withdraw until closes_at, then an admin
-- creates the tournament from the list. The deadline is enforced here, not only in the page.
-- Safe to run more than once.

create table if not exists public.signups (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 3 and 70),
  closes_at timestamptz not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  season_id uuid references public.seasons on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.signup_entries (
  signup_id uuid not null references public.signups on delete cascade,
  profile_id uuid not null references public.profiles on delete cascade,
  created_at timestamptz not null default now(),
  primary key (signup_id, profile_id)
);

alter table public.signups enable row level security;
alter table public.signup_entries enable row level security;
drop policy if exists "signups are public" on public.signups;
create policy "signups are public" on public.signups for select to anon, authenticated using (true);
-- No policy on signup_entries: it holds account ids, so it is read through signup_list() below.

-- Who joined, in order. Public like the standings: usernames only, plus whether the account is approved.
create or replace function public.signup_list(p_signup uuid)
returns table (username text, player_id uuid, approved boolean, joined_at timestamptz, mine boolean)
language sql stable security definer set search_path = '' as $$
  select p.username, case when p.status = 'approved' then p.player_id end, p.status = 'approved', e.created_at,
         coalesce(e.profile_id = auth.uid(), false)
  from public.signup_entries e join public.profiles p on p.id = e.profile_id
  where e.signup_id = p_signup and p.status <> 'rejected'
  order by e.created_at
$$;

create or replace function private.open_signup(p_signup uuid) returns public.signups
language plpgsql stable security definer set search_path = '' as $$
declare sg public.signups;
begin
  select * into sg from public.signups where id = p_signup;
  if not found then raise exception 'Kayıt bulunamadı.'; end if;
  if sg.status <> 'open' or now() >= sg.closes_at then raise exception 'Kayıtlar kapandı.'; end if;
  return sg;
end $$;

create or replace function public.signup_join(p_signup uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  sg public.signups := private.open_signup(p_signup);
  st text;
begin
  select status into st from public.profiles where id = auth.uid();
  if st is null then raise exception 'Katılmak için giriş yapın.'; end if;
  if st = 'rejected' then raise exception 'Hesabınız onaylanmadı.'; end if;
  insert into public.signup_entries (signup_id, profile_id) values (p_signup, auth.uid()) on conflict do nothing;
  perform private.log(sg.title || ' kaydına katıldı');
end $$;

create or replace function public.signup_withdraw(p_signup uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare sg public.signups := private.open_signup(p_signup);
begin
  if auth.uid() is null then raise exception 'Giriş yapmanız gerekiyor.'; end if;
  delete from public.signup_entries where signup_id = p_signup and profile_id = auth.uid();
  perform private.log(sg.title || ' kaydından çekildi');
end $$;

create or replace function public.admin_save_signup(p_signup uuid, p_title text, p_closes_at timestamptz) returns uuid
language plpgsql security definer set search_path = '' as $$
declare sid uuid := p_signup;
begin
  perform private.require_admin();
  if p_closes_at is null then raise exception 'Son kayıt zamanı gerekiyor.'; end if;
  if sid is null then
    insert into public.signups (title, closes_at) values (trim(p_title), p_closes_at) returning id into sid;
    perform private.log(trim(p_title) || ' için kayıt açıldı');
  else
    update public.signups set title = trim(p_title), closes_at = p_closes_at, status = 'open' where id = sid;
    if not found then raise exception 'Kayıt bulunamadı.'; end if;
    perform private.log(trim(p_title) || ' kaydı güncellendi');
  end if;
  return sid;
end $$;

-- Closes registration, optionally linking the season created from it.
create or replace function public.admin_close_signup(p_signup uuid, p_season uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare nm text;
begin
  perform private.require_admin();
  update public.signups set status = 'closed', season_id = coalesce(p_season, season_id) where id = p_signup returning title into nm;
  if nm is null then raise exception 'Kayıt bulunamadı.'; end if;
  perform private.log(nm || ' kaydı kapatıldı');
end $$;

revoke execute on function private.open_signup(uuid) from public;
revoke execute on function public.signup_join(uuid), public.signup_withdraw(uuid), public.admin_save_signup(uuid, text, timestamptz),
  public.admin_close_signup(uuid, uuid) from public, anon;
grant execute on function public.signup_join(uuid), public.signup_withdraw(uuid), public.admin_save_signup(uuid, text, timestamptz),
  public.admin_close_signup(uuid, uuid) to authenticated;
grant execute on function public.signup_list(uuid) to anon, authenticated;

-- The first registration: 29 Ekim Cumhuriyet Turnuvası, closing 28 October 23:59 Turkey time.
insert into public.signups (title, closes_at)
select '29 Ekim Cumhuriyet Turnuvası', '2026-10-28 23:59:00+03'
where not exists (select 1 from public.signups where title = '29 Ekim Cumhuriyet Turnuvası');
