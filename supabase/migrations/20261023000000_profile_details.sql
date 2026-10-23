-- Profile details: graduation year next to the real name, editable by the member themselves and by
-- admins. Like real names, graduation years are visible to approved members only. Safe to run twice.

alter table public.profiles add column if not exists grad_year smallint check (grad_year between 1950 and 2040);
alter table public.player_private add column if not exists grad_year smallint check (grad_year between 1950 and 2040);

-- New accounts may send grad_year in the sign-up metadata.
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  uname text := new.raw_user_meta_data->>'username';
  gy text := new.raw_user_meta_data->>'grad_year';
begin
  if uname is null or not public.valid_username(uname) then
    raise exception 'Geçersiz kullanıcı adı.';
  end if;
  if split_part(new.email, '@', 1) <> public.login_local(public.username_key(uname)) then
    raise exception 'Kullanıcı adı ile giriş anahtarı uyuşmuyor.';
  end if;
  insert into public.profiles (id, username, real_name, grad_year)
  values (new.id, uname, nullif(left(trim(new.raw_user_meta_data->>'real_name'), 80), ''),
          case when gy ~ '^\d{4}$' and gy::int between 1950 and 2040 then gy::smallint end);
  return new;
end $$;

-- Copies an account's details onto its player (members see them through player_private).
create or replace function private.sync_player_details(p_profile uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.player_private (player_id, real_name, grad_year)
  select player_id, real_name, grad_year from public.profiles where id = p_profile and player_id is not null
  on conflict (player_id) do update set real_name = excluded.real_name, grad_year = excluded.grad_year
$$;

-- On approval: keep whatever is already known about the player (e.g. entered by an admin before the
-- person had an account), fill the gaps from the account, and show the merged result on the account.
create or replace function private.merge_player_details(p_profile uuid, p_player uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.player_private (player_id, real_name, grad_year)
  select p_player, real_name, grad_year from public.profiles where id = p_profile
  on conflict (player_id) do update set real_name = coalesce(excluded.real_name, public.player_private.real_name),
                                         grad_year = coalesce(excluded.grad_year, public.player_private.grad_year);
  update public.profiles pr set real_name = pp.real_name, grad_year = pp.grad_year
  from public.player_private pp where pr.id = p_profile and pp.player_id = p_player;
end $$;

create or replace function private.clean_grad_year(p int) returns smallint
language plpgsql immutable set search_path = '' as $$
begin
  if p is null then return null; end if;
  if p < 1950 or p > 2040 then raise exception 'Mezuniyet yılı 1950 ile 2040 arasında olmalı.'; end if;
  return p;
end $$;

drop function if exists public.update_my_profile(text);
create or replace function public.update_my_profile(p_real_name text, p_grad_year int default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Giriş yapmanız gerekiyor.'; end if;
  update public.profiles set real_name = nullif(left(trim(p_real_name), 80), ''), grad_year = private.clean_grad_year(p_grad_year)
  where id = auth.uid();
  perform private.sync_player_details(auth.uid());
end $$;

-- Admins can fill in details for anyone, including players without an account.
create or replace function public.admin_update_player(p_player uuid, p_real_name text, p_grad_year int default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  clean text := nullif(left(trim(p_real_name), 80), '');
  gy smallint := private.clean_grad_year(p_grad_year);
  nm text;
begin
  perform private.require_admin();
  select username into nm from public.players where id = p_player;
  if nm is null then raise exception 'Oyuncu bulunamadı.'; end if;
  insert into public.player_private (player_id, real_name, grad_year) values (p_player, clean, gy)
  on conflict (player_id) do update set real_name = excluded.real_name, grad_year = excluded.grad_year;
  update public.profiles set real_name = clean, grad_year = gy where player_id = p_player;
  perform private.log(nm || ' bilgileri güncellendi');
end $$;

-- Approval and the admin bootstrap now carry the graduation year over too.
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
  update public.profiles set status = 'approved', player_id = pid where id = p_profile;
  perform private.merge_player_details(p_profile, pid);
  perform private.log(pr.username || ' hesabı onaylandı');
end $$;

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
  update public.profiles set is_admin = true, status = 'approved', player_id = pid where id = pr.id;
  perform private.merge_player_details(pr.id, pid);
end $$;

revoke execute on function private.sync_player_details(uuid), private.merge_player_details(uuid, uuid), private.clean_grad_year(int), private.make_admin(text) from public;
revoke execute on function public.update_my_profile(text, int), public.admin_update_player(uuid, text, int) from public, anon;
grant execute on function public.update_my_profile(text, int), public.admin_update_player(uuid, text, int) to authenticated;
