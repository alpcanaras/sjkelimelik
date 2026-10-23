/* Local stand-in for src/api.js: same exports, but backed by PGlite running in the browser with
   the real migration, so the real UI exercises the real database rules without Supabase.
   Served in place of src/api.js by tests/ui/serve.mjs. Data persists in IndexedDB; ?reset clears it. */
import { PGlite } from '/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from '/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';
import { usernameKey, loginLocal, planSeason } from './engine.js';

const DOMAIN = 'kullanici.sjkelimelik.invalid';
const MIGRATIONS = ['20261017000000_init.sql', '20261018000000_username_symbols.sql', '20261023000000_profile_details.sql'];
const SESSION_KEY = 'fake-session';
const STUB = `
  create role anon nologin; create role authenticated nologin; create role supabase_auth_admin nologin;
  create schema auth; create schema extensions;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text unique,
    encrypted_password text, raw_user_meta_data jsonb, updated_at timestamptz);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public, auth to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;`;

if (new URLSearchParams(location.search).has('reset')) {
  indexedDB.deleteDatabase('/pglite/sj-local');
  localStorage.removeItem(SESSION_KEY);
  history.replaceState(null, '', location.pathname);
}
const db = new PGlite('idb://sj-local', { extensions: { pgcrypto } });
let uid = localStorage.getItem(SESSION_KEY);
const listeners = [];

async function as(user, sql, params = []) {
  return db.transaction(async tx => {
    await tx.query(`set local role ${user ? 'authenticated' : 'anon'}`);
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [user || '']);
    return (await tx.query(sql, params)).rows;
  });
}
const clean = e => new Error(String(e.message || e).replace(/^error:\s*/i, ''));

async function createUser(username, password, realName, gradYear) {
  const { rows } = await db.query(
    `insert into auth.users (email, encrypted_password, raw_user_meta_data)
     values ($1, extensions.crypt($2, extensions.gen_salt('bf')), $3) returning id`,
    [loginLocal(usernameKey(username)) + '@' + DOMAIN, password, { username, real_name: realName || null, grad_year: gradYear ? String(gradYear) : null }]);
  return rows[0].id;
}

// First run: schema plus a small demo league (admin "alp", password "test1234" for every account).
const ready = (async () => {
  const exists = (await db.query(`select to_regclass('public.players') as t`)).rows[0].t;
  if (exists) return;
  await db.exec(STUB);
  for (const f of MIGRATIONS) await db.exec(await (await fetch('/supabase/migrations/' + f)).text());
  const names = ['alp', 'Ayşe', 'mehmet', 'zeynep', 'ahmet', 'selin'];
  const ids = {};
  for (const n of names) ids[n] = await createUser(n, 'test1234', n === 'Ayşe' ? 'Ayşe Erdem' : null);
  await db.query(`select private.make_admin('alp')`);
  for (const n of names.slice(1, 5)) await as(ids.alp, 'select public.approve_profile($1, null)', [ids[n]]);
  await as(ids.alp, `select public.admin_add_player('eski_usta', 'Eski Usta')`);
  const players = (await db.query('select id from public.players order by created_at')).rows.map(r => r.id);
  const plan = planSeason({ format: 'league', ids: players, legs: 2 });
  await as(ids.alp, 'select public.admin_create_season($1)', [{
    name: '2026 Güz Ligi', format: 'league', legs: 2, player_ids: players, groups: [],
    matches: plan.matches.map(m => ({ phase: m.phase, group_id: null, round: m.round, leg: m.leg, slot: m.slot, a: m.a, b: m.b }))
  }]);
  const first = (await db.query(`select id from public.matches where round <= 2 order by round, slot`)).rows;
  for (const [i, m] of first.entries()) await as(ids.alp, 'select public.admin_set_score($1,$2,$3)', [m.id, 300 + i * 13 % 90, 280 + i * 29 % 100]);
})();

export const configured = true;
export const crestUrl = 'assets/saint-joseph-crest-cropped.png';

export async function getSession() { await ready; return uid ? { user: { id: uid } } : null; }
export function onAuthChange(fn) { listeners.push(fn); }
function setSession(id) { uid = id; id ? localStorage.setItem(SESSION_KEY, id) : localStorage.removeItem(SESSION_KEY); return id ? { user: { id } } : null; }

export async function signIn(username, password) {
  await ready;
  const row = (await db.query(`select id from auth.users where email = $1 and encrypted_password = extensions.crypt($2, encrypted_password)`,
    [loginLocal(usernameKey(username.trim())) + '@' + DOMAIN, password])).rows[0];
  if (!row) throw new Error('Kullanıcı adı veya şifre hatalı.');
  return setSession(row.id);
}
export async function signUp(username, password, realName, gradYear) {
  await ready;
  try { return setSession(await createUser(username.trim(), password, realName?.trim(), gradYear)); }
  catch (e) { throw /unique|duplicate/i.test(e.message) ? new Error('Bu kullanıcı adı alınmış.') : clean(e); }
}
export async function signOut() { setSession(null); }
export async function myProfile(id) { return (await as(uid, 'select * from public.profiles where id = $1', [id]))[0] || null; }

const toMatch = r => ({
  id: r.id, seasonId: r.season_id, a: r.player_a, b: r.player_b, round: r.round, leg: r.leg, slot: r.slot,
  phase: r.phase, groupId: r.group_id, status: r.status, scoreA: r.score_a, scoreB: r.score_b,
  pendingScore: r.pending_a == null ? null : { a: r.pending_a, b: r.pending_b }, pendingBy: r.pending_by,
  finalizedAt: r.finalized_at ? new Date(r.finalized_at).getTime() : null
});

export async function loadAll({ member = false, admin = false } = {}) {
  await ready;
  const q = sql => as(uid, sql);
  const [players, seasons, matches, names, profiles, audits] = await Promise.all([
    q('select id, username, created_at from public.players order by id'),
    q('select * from public.seasons order by created_at'),
    q('select * from public.matches order by id'),
    member ? q('select player_id, real_name, grad_year from public.player_private') : [],
    admin ? q('select id, username, username_key, real_name, grad_year, status, is_admin, player_id, created_at from public.profiles order by created_at') : [],
    admin ? q('select * from public.audit_log order by id desc limit 60') : []
  ]);
  const details = new Map(names.map(n => [n.player_id, n]));
  return {
    players: players.map(p => ({ id: p.id, username: p.username, realName: details.get(p.id)?.real_name || null, gradYear: details.get(p.id)?.grad_year || null })),
    seasons: seasons.map(s => ({
      id: s.id, name: s.name, format: s.format, status: s.status, stage: s.stage, legs: s.legs, seedStrategy: s.seed_strategy,
      players: s.player_ids, groups: s.groups || [], bracket: s.bracket, createdAt: s.created_at,
      matches: matches.filter(m => m.season_id === s.id).map(toMatch)
        .sort((x, y) => x.phase.localeCompare(y.phase) || x.round - y.round || (x.slot ?? 0) - (y.slot ?? 0))
    })),
    profiles, audits
  };
}
export function subscribe() {}
export async function pendingProfileCount() {
  return Number((await as(uid, `select count(*) as n from public.profiles where status = 'pending'`))[0].n);
}

async function call(fn, args) {
  const keys = Object.keys(args);
  try {
    const rows = await as(uid, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, keys.map(k => args[k]));
    return rows[0]?.r ?? null;
  } catch (e) { throw clean(e); }
}
export const submitScore = (id, a, b) => call('submit_score', { p_match: id, p_a: a, p_b: b });
export const respondScore = (id, accept) => call('respond_score', { p_match: id, p_accept: accept });
export const updateMyProfile = (realName, gradYear) => call('update_my_profile', { p_real_name: realName, p_grad_year: gradYear ?? null });
export const adminUpdatePlayer = (id, realName, gradYear) => call('admin_update_player', { p_player: id, p_real_name: realName || null, p_grad_year: gradYear ?? null });
export const adminSetScore = (id, a, b) => call('admin_set_score', { p_match: id, p_a: a, p_b: b });
export const adminResetMatch = id => call('admin_reset_match', { p_match: id });
export const adminCreateSeason = ({ name, format, legs, strategy, ids, plan }) => call('admin_create_season', {
  p: {
    name, format, legs, seed_strategy: format === 'cup' ? strategy : null, player_ids: ids, groups: plan.groups,
    matches: plan.matches.map(m => ({ phase: m.phase, group_id: m.groupId, round: m.round, leg: m.leg, slot: m.slot, a: m.a, b: m.b }))
  }
});
export const adminCreateKnockout = (seasonId, plan) => call('admin_create_knockout', { p_season: seasonId, p: plan });
export const adminDeleteSeason = id => call('admin_delete_season', { p_season: id });
export const approveProfile = (id, playerId = null) => call('approve_profile', { p_profile: id, p_player: playerId });
export const rejectProfile = id => call('reject_profile', { p_profile: id });
export const adminAddPlayer = (username, realName) => call('admin_add_player', { p_username: username, p_real_name: realName || null });
export const adminSetAdmin = (id, value) => call('admin_set_admin', { p_profile: id, p_value: value });
export const adminResetPassword = (id, password) => call('admin_reset_password', { p_profile: id, p_password: password });
