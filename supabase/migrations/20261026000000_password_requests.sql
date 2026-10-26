-- "Şifremi unuttum": there is no email to send a reset link to, so a forgotten password becomes a
-- request that admins see in Yönetim; they set a new password and pass it on. Safe to run twice.

create table if not exists public.password_requests (
  id bigint generated always as identity primary key,
  profile_id uuid not null unique references public.profiles on delete cascade,
  note text check (char_length(note) <= 120),
  created_at timestamptz not null default now()
);
alter table public.password_requests enable row level security;
drop policy if exists "password requests for admins" on public.password_requests;
create policy "password requests for admins" on public.password_requests for select to authenticated using (private.is_admin());

-- Anyone may ask (they cannot log in, after all). Unknown usernames are ignored silently so the form
-- does not reveal which accounts exist; one open request per account, a repeat just refreshes it.
create or replace function public.request_password_reset(p_username text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare pid uuid;
begin
  select id into pid from public.profiles where username_key = public.username_key(trim(p_username)) and status <> 'rejected';
  if pid is null then return; end if;
  insert into public.password_requests (profile_id, note) values (pid, nullif(left(trim(p_note), 120), ''))
  on conflict (profile_id) do update set note = excluded.note, created_at = now();
end $$;

create or replace function public.admin_clear_password_request(p_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin();
  delete from public.password_requests where id = p_id;
end $$;

-- Setting a new password also closes that account's request.
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
  delete from public.password_requests where profile_id = p_profile;
  perform private.log(nm || ' için şifre sıfırlandı');
end $$;

grant execute on function public.request_password_reset(text, text) to anon, authenticated;
revoke execute on function public.admin_clear_password_request(bigint) from public, anon;
grant execute on function public.admin_clear_password_request(bigint) to authenticated;
