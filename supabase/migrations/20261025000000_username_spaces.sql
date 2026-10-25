-- Usernames may contain single spaces between words ("Ali Veli"). The app trims and collapses
-- spaces before signing up or logging in, so the stored name never starts/ends with a space or
-- has two in a row. Names with spaces get the hex-encoded login key from public.login_local.
-- Mirrors validUsername in src/engine.js. Safe to run more than once.

create or replace function public.valid_username(name text) returns boolean
language sql immutable set search_path = '' as $$
  select char_length(name) between 3 and 20
     and name ~ '^[!-~ÇĞİÖŞÜçğıöşü]+( [!-~ÇĞİÖŞÜçğıöşü]+)*$'
     and name ~ '[A-Za-z0-9ÇĞİÖŞÜçğıöşü]'
$$;
