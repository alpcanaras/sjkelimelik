-- Kelimelik usernames may contain symbols such as ! ? @ -. Allow any visible ASCII character
-- (plus Turkish letters), no spaces, 3-20 characters, at least one letter or digit.
-- Mirrors validUsername / loginLocal in src/engine.js. Safe to run more than once.

create or replace function public.valid_username(name text) returns boolean
language sql immutable set search_path = '' as $$
  select name ~ '^[!-~ÇĞİÖŞÜçğıöşü]{3,20}$' and name ~ '[A-Za-z0-9ÇĞİÖŞÜçğıöşü]'
$$;

-- The email local part the app signs up with. Names made of letters, digits, _ and single dots
-- keep their plain key (so existing accounts are unchanged); anything else is hex-encoded
-- behind an "h-" prefix, which a plain key can never contain.
create or replace function public.login_local(key text) returns text
language sql immutable set search_path = '' as $$
  select case when key ~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$' then key
              else 'h-' || encode(convert_to(key, 'UTF8'), 'hex') end
$$;

create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare uname text := new.raw_user_meta_data->>'username';
begin
  if uname is null or not public.valid_username(uname) then
    raise exception 'Geçersiz kullanıcı adı.';
  end if;
  if split_part(new.email, '@', 1) <> public.login_local(public.username_key(uname)) then
    raise exception 'Kullanıcı adı ile giriş anahtarı uyuşmuyor.';
  end if;
  insert into public.profiles (id, username, real_name)
  values (new.id, uname, nullif(left(trim(new.raw_user_meta_data->>'real_name'), 80), ''));
  return new;
end $$;
