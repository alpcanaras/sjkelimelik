// Runs the Supabase migration in PGlite (in-process Postgres) with a minimal stand-in for
// Supabase's auth schema and API roles, then exercises the rules through those roles.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { planSeason, planKnockout, usernameKey } from '../src/engine.js';

const DOMAIN = 'kullanici.sjkelimelik.invalid';
const root = new URL('../', import.meta.url);
const db = new PGlite({ extensions: { pgcrypto } });

const SUPABASE_STUB = `
  create role anon nologin; create role authenticated nologin; create role supabase_auth_admin nologin;
  create schema auth; create schema extensions;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text unique,
    encrypted_password text, raw_user_meta_data jsonb, updated_at timestamptz);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public, auth to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
  create publication supabase_realtime;
`;

// Run SQL as an API role, the way PostgREST does: role + JWT subject, inside a transaction.
async function as(user, sql, params = []) {
  return db.transaction(async tx => {
    await tx.query(`set local role ${user ? 'authenticated' : 'anon'}`);
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [user || '']);
    return (await tx.query(sql, params)).rows;
  });
}
const rpc = (user, fn, args = []) =>
  as(user, `select public.${fn}(${args.map((_, i) => '$' + (i + 1)).join(',')}) as r`, args).then(r => r[0]?.r);

async function signup(username, realName = null) {
  const { rows } = await db.query(
    `insert into auth.users (email, encrypted_password, raw_user_meta_data)
     values ($1, extensions.crypt('secret123', extensions.gen_salt('bf')), $2) returning id`,
    [usernameKey(username) + '@' + DOMAIN, { username, real_name: realName }]);
  return rows[0].id;
}

const u = {};
const playerOf = async id => (await db.query('select player_id from public.profiles where id=$1', [id])).rows[0].player_id;
async function seasonView(id) {
  const s = (await db.query('select * from public.seasons where id=$1', [id])).rows[0];
  const matches = (await db.query('select * from public.matches where season_id=$1', [id])).rows;
  return {
    id, format: s.format, stage: s.stage, players: s.player_ids, groups: s.groups, bracket: s.bracket,
    matches: matches.map(m => ({ id: m.id, a: m.player_a, b: m.player_b, round: m.round, slot: m.slot, phase: m.phase,
      groupId: m.group_id, status: m.status, scoreA: m.score_a, scoreB: m.score_b }))
  };
}

before(async () => {
  await db.exec(SUPABASE_STUB);
  for (const f of readdirSync(new URL('supabase/migrations/', root)).sort())
    await db.exec(readFileSync(new URL('supabase/migrations/' + f, root), 'utf8'));
  for (const name of ['alp', 'Ayşe', 'mehmet', 'zeynep', 'ahmet', 'selin', 'murat', 'elif']) u[name] = await signup(name, name === 'Ayşe' ? 'Ayşe Erdem' : null);
  await db.query(`select private.make_admin('alp')`);
});

test('signup trigger creates pending profiles and rejects mismatched usernames', async () => {
  const p = (await db.query('select * from public.profiles where id=$1', [u['Ayşe']])).rows[0];
  assert.equal(p.status, 'pending');
  assert.equal(p.username_key, 'ayse');
  assert.equal(p.real_name, 'Ayşe Erdem');
  await assert.rejects(db.query(`insert into auth.users (email, raw_user_meta_data) values ('bob@${DOMAIN}', '{"username":"alice"}')`), /uyuşmuyor/);
  await assert.rejects(db.query(`insert into auth.users (email, raw_user_meta_data) values ('x@${DOMAIN}', '{"username":"x"}')`), /Geçersiz/);
  await assert.rejects(signup('ayse'), /duplicate|unique/i, 'Turkish letters fold, so ayse = Ayşe');
});

test('bootstrap admin is approved, linked to a player and an admin', async () => {
  const p = (await db.query('select * from public.profiles where id=$1', [u.alp])).rows[0];
  assert.equal(p.is_admin, true);
  assert.equal(p.status, 'approved');
  assert.ok(p.player_id);
});

test('anonymous visitors can read public data only and cannot write', async () => {
  assert.equal((await as(null, 'select * from public.profiles')).length, 0);
  assert.equal((await as(null, 'select * from public.player_private')).length, 0);
  assert.ok((await as(null, 'select * from public.players')).length >= 1);
  await assert.rejects(as(null, `insert into public.players (username) values ('hacker')`), /row-level security|permission/);
  await assert.rejects(rpc(null, 'admin_add_player', ['hacker', null]), /permission denied/);
  await assert.rejects(rpc(null, 'submit_score', ['00000000-0000-0000-0000-000000000000', 1, 2]), /permission denied/);
  await assert.rejects(as(null, 'select private.log($1)', ['x']), /permission denied/);
});

test('pending accounts cannot act or read real names; non-admins cannot approve', async () => {
  assert.equal((await as(u.mehmet, 'select * from public.player_private')).length, 0);
  assert.equal((await as(u.mehmet, 'select * from public.profiles')).length, 1, 'sees only own profile');
  await assert.rejects(rpc(u.mehmet, 'approve_profile', [u.mehmet, null]), /yönetici yetkisi/);
  await assert.rejects(as(u.mehmet, `update public.profiles set is_admin = true where id = $1 returning id`, [u.mehmet]).then(r => { if (!r.length) throw new Error('row-level security'); }), /row-level security/);
});

test('admin approves accounts and can link one to an existing player', async () => {
  const legacy = await rpc(u.alp, 'admin_add_player', ['eski_oyuncu', 'Eski Oyuncu']);
  await rpc(u.alp, 'approve_profile', [u.elif, legacy]);
  assert.equal(await playerOf(u.elif), legacy);
  for (const n of ['Ayşe', 'mehmet', 'zeynep', 'ahmet', 'selin', 'murat']) await rpc(u.alp, 'approve_profile', [u[n], null]);
  assert.ok(await playerOf(u['Ayşe']));
  const names = await as(u.mehmet, 'select real_name from public.player_private');
  assert.ok(names.some(r => r.real_name === 'Ayşe Erdem'), 'approved members see real names');
  assert.equal((await as(u.alp, 'select * from public.profiles')).length, 8, 'admin sees every account');
  await assert.rejects(rpc(u.alp, 'admin_add_player', ['eski_oyuncu', null]), /zaten var/);
});

let league;
test('league: submit, confirm, dispute and admin correction follow the rules', async () => {
  const ids = await Promise.all(['alp', 'Ayşe', 'mehmet', 'zeynep'].map(n => playerOf(u[n])));
  const plan = planSeason({ format: 'league', ids, legs: 2 });
  league = await rpc(u.alp, 'admin_create_season', [{ name: '2026 Güz Ligi', format: 'league', legs: 2, player_ids: ids, groups: plan.groups, matches: plan.matches.map(m => ({ ...m, group_id: m.groupId })) }]);
  let s = await seasonView(league);
  assert.equal(s.matches.length, 12);
  await assert.rejects(rpc(u.mehmet, 'admin_create_season', [{ name: 'x', format: 'league', player_ids: ids, matches: [] }]), /yönetici/);

  const [ay, me, ze] = [await playerOf(u['Ayşe']), await playerOf(u.mehmet), await playerOf(u.zeynep)];
  const m = s.matches.find(x => [x.a, x.b].includes(ay) && [x.a, x.b].includes(me));
  await assert.rejects(rpc(u.zeynep, 'submit_score', [m.id, 400, 300]), /kendi maçınız/);
  await assert.rejects(rpc(u['Ayşe'], 'submit_score', [m.id, -1, 300]), /0 ile 9999/);
  await rpc(u['Ayşe'], 'submit_score', [m.id, 400, 300]);
  await assert.rejects(rpc(u['Ayşe'], 'submit_score', [m.id, 400, 300]), /açık değil/);
  await assert.rejects(rpc(u['Ayşe'], 'respond_score', [m.id, true]), /rakibiniz/, 'submitter cannot confirm');
  await assert.rejects(rpc(u.zeynep, 'respond_score', [m.id, true]), /rakibiniz/, 'third player cannot confirm');
  await rpc(u.mehmet, 'respond_score', [m.id, true]);
  let row = (await db.query('select * from public.matches where id=$1', [m.id])).rows[0];
  assert.equal(row.status, 'done');
  assert.deepEqual([row.score_a, row.score_b], [400, 300]);
  assert.ok(row.finalized_at);

  const zm = s.matches.find(x => [x.a, x.b].includes(ze) && x.status === 'scheduled');
  const zOpp = zm.a === ze ? zm.b : zm.a;
  await rpc(u.zeynep, 'submit_score', [zm.id, 350, 351]);
  const oppAccount = (await db.query('select id from public.profiles where player_id=$1', [zOpp])).rows[0].id;
  await rpc(oppAccount, 'respond_score', [zm.id, false]);
  assert.equal((await db.query('select status from public.matches where id=$1', [zm.id])).rows[0].status, 'disputed');
  await assert.rejects(rpc(u.zeynep, 'admin_set_score', [zm.id, 351, 350]), /yönetici/);
  await rpc(u.alp, 'admin_set_score', [zm.id, 351, 350]);
  row = (await db.query('select * from public.matches where id=$1', [zm.id])).rows[0];
  assert.equal(row.status, 'done');
  assert.deepEqual([row.score_a, row.score_b], [351, 350]);

  for (const x of (await seasonView(league)).matches.filter(x => x.status !== 'done')) await rpc(u.alp, 'admin_set_score', [x.id, 300, 299]);
  assert.equal((await db.query('select status from public.seasons where id=$1', [league])).rows[0].status, 'finished');
  await rpc(u.alp, 'admin_reset_match', [m.id]);
  assert.equal((await db.query('select status from public.seasons where id=$1', [league])).rows[0].status, 'live');
});

test('cup: knockout advances winners and admin corrections re-pair later rounds', async () => {
  const ids = await Promise.all(['alp', 'Ayşe', 'mehmet', 'zeynep', 'ahmet', 'selin', 'murat', 'elif'].map(n => playerOf(u[n])));
  const plan = planSeason({ format: 'cup', ids, strategy: 'pots', size: 4 });
  const cup = await rpc(u.alp, 'admin_create_season', [{ name: '2027 Kupa', format: 'cup', seed_strategy: 'pots', player_ids: ids, groups: plan.groups, matches: plan.matches.map(m => ({ ...m, group_id: m.groupId })) }]);
  let s = await seasonView(cup);
  assert.equal(s.stage, 'groups');
  assert.equal(s.matches.length, 12);
  assert.throws(() => planKnockout(s), /grup maçları/);
  await assert.rejects(rpc(u.alp, 'admin_create_knockout', [cup, { bracket: { size: 4 }, matches: [] }]), /grup maçları/);
  for (const m of s.matches) await rpc(u.alp, 'admin_set_score', [m.id, 300 + (m.round * 7) % 50, 280]);

  s = await seasonView(cup);
  const ko = planKnockout(s);
  assert.equal(ko.bracket.size, 4);
  await rpc(u.alp, 'admin_create_knockout', [cup, ko]);
  s = await seasonView(cup);
  assert.equal(s.stage, 'knockout');
  const semis = s.matches.filter(m => m.phase === 'knockout' && m.round === 0).sort((a, b) => a.slot - b.slot);
  const final = () => db.query(`select * from public.matches where season_id=$1 and phase='knockout' and round=1`, [cup]).then(r => r.rows[0]);
  assert.equal((await final()).status, 'waiting');
  await assert.rejects(rpc(u.alp, 'admin_set_score', [semis[0].id, 300, 300]), /beraberlik/);
  await rpc(u.alp, 'admin_set_score', [semis[0].id, 400, 300]);
  await rpc(u.alp, 'admin_set_score', [semis[1].id, 300, 400]);
  let f = await final();
  assert.equal(f.status, 'scheduled');
  assert.deepEqual([f.player_a, f.player_b], [semis[0].a, semis[1].b]);

  await rpc(u.alp, 'admin_set_score', [f.id, 410, 390]);
  assert.equal((await db.query('select status from public.seasons where id=$1', [cup])).rows[0].status, 'finished');

  // Correcting a semi-final flips its winner: the final is re-paired and cleared.
  await rpc(u.alp, 'admin_set_score', [semis[0].id, 300, 400]);
  f = await final();
  assert.deepEqual([f.player_a, f.player_b, f.status, f.score_a], [semis[0].b, semis[1].b, 'scheduled', null]);
  assert.equal((await db.query('select status from public.seasons where id=$1', [cup])).rows[0].status, 'live');
});

test('admin can reset passwords and manage admins, with guard rails', async () => {
  await assert.rejects(rpc(u.alp, 'admin_reset_password', [u.mehmet, 'short']), /8 karakter/);
  await rpc(u.alp, 'admin_reset_password', [u.mehmet, 'yenisifre123']);
  const ok = (await db.query(`select encrypted_password = extensions.crypt('yenisifre123', encrypted_password) as ok from auth.users where id=$1`, [u.mehmet])).rows[0].ok;
  assert.equal(ok, true);
  await assert.rejects(rpc(u.mehmet, 'admin_reset_password', [u.alp, 'hijacked123']), /yönetici/);
  await assert.rejects(rpc(u.alp, 'admin_set_admin', [u.alp, false]), /Kendi/);
  await rpc(u.alp, 'admin_set_admin', [u.zeynep, true]);
  await rpc(u.zeynep, 'admin_add_player', ['yeni_oyuncu', null]);
  const log = await as(u.zeynep, 'select actor_name, action from public.audit_log order by id desc limit 1');
  assert.deepEqual(log[0], { actor_name: 'zeynep', action: 'yeni_oyuncu oyuncu olarak eklendi' });
  assert.equal((await as(u.mehmet, 'select * from public.audit_log')).length, 0, 'non-admins cannot read the audit log');
  await rpc(u.alp, 'reject_profile', [u.zeynep]);
  await assert.rejects(rpc(u.zeynep, 'admin_add_player', ['baska', null]), /yönetici/, 'rejected admin loses rights');
});

test('members can update their own real name', async () => {
  await rpc(u.mehmet, 'update_my_profile', ['Mehmet Yılmaz']);
  const pid = await playerOf(u.mehmet);
  assert.equal((await db.query('select real_name from public.player_private where player_id=$1', [pid])).rows[0].real_name, 'Mehmet Yılmaz');
});
