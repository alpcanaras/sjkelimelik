/* Data access: Supabase auth, table reads and the server-side action functions.
   Maps database rows to the shapes src/engine.js works with. */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import config from '../config.js';
import { usernameKey, loginLocal, normalizeUsername } from './engine.js';

export const configured = Boolean(config.SUPABASE_URL && config.SUPABASE_ANON_KEY);
const sb = configured ? createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY) : null;
const PAGE = 1000; // PostgREST returns at most 1000 rows per request

const loginEmail = username => loginLocal(usernameKey(normalizeUsername(username))) + '@' + config.AUTH_EMAIL_DOMAIN;

const AUTH_MESSAGES = [
  [/invalid login credentials/i, 'Kullanıcı adı veya şifre hatalı.'],
  [/already registered|already exists|duplicate/i, 'Bu kullanıcı adı alınmış.'],
  [/password should be at least/i, 'Şifre çok kısa.'],
  [/rate limit|too many/i, 'Çok fazla deneme yapıldı. Biraz sonra tekrar deneyin.'],
  [/email not confirmed/i, 'Supabase ayarlarında "Confirm email" seçeneği kapatılmalı.'],
  [/database error saving new user/i, 'Hesap oluşturulamadı. Kullanıcı adını kontrol edin.'],
  [/failed to fetch|network/i, 'Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edin.']
];
function friendly(error) {
  const msg = error?.message || String(error);
  for (const [re, text] of AUTH_MESSAGES) if (re.test(msg)) return new Error(text);
  return new Error(msg);
}
const unwrap = ({ data, error }) => { if (error) throw friendly(error); return data; };

// ------------------------------------------------------------------ auth
export async function getSession() {
  return configured ? unwrap(await sb.auth.getSession()).session : null;
}
// supabase-js runs these callbacks while holding its auth lock, so calling the client from
// inside one can deadlock. Hand the session over on the next tick instead.
export function onAuthChange(fn) {
  if (configured) sb.auth.onAuthStateChange((_event, session) => { setTimeout(() => fn(session), 0); });
}
export async function signIn(username, password) {
  return unwrap(await sb.auth.signInWithPassword({ email: loginEmail(username), password })).session;
}
export async function signUp(username, password, realName, gradYear) {
  const data = unwrap(await sb.auth.signUp({
    email: loginEmail(username), password,
    options: { data: { username: normalizeUsername(username), real_name: realName?.trim() || null, grad_year: gradYear ? String(gradYear) : null } }
  }));
  if (!data.session) throw new Error('Hesap oluşturuldu ancak giriş açılmadı: Supabase\'de "Confirm email" kapatılmalı.');
  return data.session;
}
export async function signOut() { unwrap(await sb.auth.signOut()); }

export async function myProfile(userId) {
  return unwrap(await sb.from('profiles').select('*').eq('id', userId).maybeSingle());
}

// ------------------------------------------------------------------ reads
async function selectAll(table, columns, order = 'id') {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const page = unwrap(await sb.from(table).select(columns).order(order).range(from, from + PAGE - 1));
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

const toMatch = r => ({
  id: r.id, seasonId: r.season_id, a: r.player_a, b: r.player_b, round: r.round, leg: r.leg, slot: r.slot,
  phase: r.phase, groupId: r.group_id, status: r.status, scoreA: r.score_a, scoreB: r.score_b,
  pendingScore: r.pending_a == null ? null : { a: r.pending_a, b: r.pending_b }, pendingBy: r.pending_by,
  finalizedAt: r.finalized_at ? Date.parse(r.finalized_at) : null
});

/* Which database updates are applied. The site works without them; the related features stay hidden
   until the migration has been run in Supabase (see supabase/migrations). */
export const features = { details: true, signups: true, resets: true };
const isMissing = e => /does not exist|could not find|schema cache|PGRST20[025]|42703|42P01/i.test(e?.message || '');
async function withFallback(flag, attempt, fallback) {
  try { const result = await attempt(); features[flag] = true; return result; }
  catch (e) { if (!isMissing(e)) throw e; features[flag] = false; return fallback(); }
}

/* Open registrations (season sign-ups) with who has joined so far. Public. */
export async function loadSignups() {
  const open = await withFallback('signups', async () => unwrap(await sb.from('signups').select('*').eq('status', 'open').order('closes_at')), () => []);
  return Promise.all(open.map(async sg => ({
    id: sg.id, title: sg.title, closesAt: Date.parse(sg.closes_at),
    entries: unwrap(await sb.rpc('signup_list', { p_signup: sg.id })).map(e => ({ username: e.username, playerId: e.player_id, approved: e.approved, mine: e.mine }))
  })));
}

/* Everything public, plus member/admin-only extras when the session allows them (RLS filters the rest). */
export async function loadAll({ member = false, admin = false } = {}) {
  const [players, seasons, matches, names, profiles, audits, signups, resets] = await Promise.all([
    selectAll('players', 'id, username, created_at'),
    selectAll('seasons', '*', 'created_at'),
    selectAll('matches', '*'),
    member ? withFallback('details', () => selectAll('player_private', 'player_id, real_name, grad_year', 'player_id'), () => selectAll('player_private', 'player_id, real_name', 'player_id')) : [],
    admin ? withFallback('details', () => selectAll('profiles', 'id, username, username_key, real_name, grad_year, status, is_admin, player_id, created_at', 'created_at'), () => selectAll('profiles', 'id, username, username_key, real_name, status, is_admin, player_id, created_at', 'created_at')) : [],
    admin ? unwrap(await sb.from('audit_log').select('*').order('id', { ascending: false }).limit(60)) : [],
    loadSignups(),
    admin ? withFallback('resets', async () => unwrap(await sb.from('password_requests').select('*').order('created_at')), () => []) : []
  ]);
  const details = new Map(names.map(n => [n.player_id, n]));
  const bySeason = new Map(seasons.map(s => [s.id, []]));
  for (const m of matches) bySeason.get(m.season_id)?.push(toMatch(m));
  return {
    players: players.map(p => ({ id: p.id, username: p.username, realName: details.get(p.id)?.real_name || null, gradYear: details.get(p.id)?.grad_year || null })),
    seasons: seasons.map(s => ({
      id: s.id, name: s.name, format: s.format, status: s.status, stage: s.stage, legs: s.legs,
      seedStrategy: s.seed_strategy, players: s.player_ids, groups: s.groups || [], bracket: s.bracket,
      createdAt: s.created_at,
      matches: (bySeason.get(s.id) || []).sort((x, y) => x.phase.localeCompare(y.phase) || x.round - y.round || (x.slot ?? 0) - (y.slot ?? 0))
    })),
    profiles, audits, signups, resets
  };
}

/* Admins only: open "forgot password" requests (0 until that migration is applied). */
export async function pendingResetCount() {
  if (!features.resets) return 0;
  const { count, error } = await sb.from('password_requests').select('id', { count: 'exact', head: true });
  if (error) throw friendly(error);
  return count ?? 0;
}

/* Admins only (RLS hides other accounts): how many accounts wait for approval. */
export async function pendingProfileCount() {
  const { count, error } = await sb.from('profiles').select('id', { count: 'exact', head: true }).eq('status', 'pending');
  if (error) throw friendly(error);
  return count ?? 0;
}

/* Calls fn (debounced) whenever matches, seasons or players change, from any browser. */
export function subscribe(fn) {
  if (!configured) return;
  let timer;
  const ping = () => { clearTimeout(timer); timer = setTimeout(fn, 400); };
  sb.channel('league')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'matches' }, ping)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'seasons' }, ping)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'players' }, ping)
    .subscribe();
}

// ------------------------------------------------------------------ actions (checked on the server)
const call = async (fn, args) => unwrap(await sb.rpc(fn, args));

export const submitScore = (id, a, b) => call('submit_score', { p_match: id, p_a: a, p_b: b });
export const respondScore = (id, accept) => call('respond_score', { p_match: id, p_accept: accept });
export const updateMyProfile = (realName, gradYear) => features.details
  ? call('update_my_profile', { p_real_name: realName, p_grad_year: gradYear ?? null })
  : call('update_my_profile', { p_real_name: realName });
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
export const signupJoin = id => call('signup_join', { p_signup: id });
export const signupWithdraw = id => call('signup_withdraw', { p_signup: id });
export const adminSaveSignup = (id, title, closesAt) => call('admin_save_signup', { p_signup: id || null, p_title: title, p_closes_at: closesAt });
export const adminCloseSignup = (id, seasonId) => call('admin_close_signup', { p_signup: id, p_season: seasonId || null });
export const requestPasswordReset = (username, note) => call('request_password_reset', { p_username: normalizeUsername(username), p_note: note || null });
export const adminClearPasswordRequest = id => call('admin_clear_password_request', { p_id: id });
export async function changePassword(password) { unwrap(await sb.auth.updateUser({ password })); }
export const adminResetPassword = (id, password) => call('admin_reset_password', { p_profile: id, p_password: password });

export const crestUrl = config.CREST_URL || (configured ? config.SUPABASE_URL.replace(/\/$/, '') + '/storage/v1/object/public/branding/crest.png' : '');
