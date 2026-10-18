/* SJ Kelimelik league engine: fixtures, standings, Elo, cup groups and knockout seeding.
   Pure functions only, no DOM and no network. Shared by the app and the tests.

   Shapes used throughout:
   season = {id, name, format:'league'|'cup', status, stage, legs, players:[id], groups:[{id,name,players}], bracket, matches}
   match  = {id, a, b, round, leg, slot, phase:'league'|'group'|'knockout', groupId, status,
             scoreA, scoreB, pendingScore:{a,b}|null, pendingBy, finalizedAt(ms)} */

export const START_ELO = 1000;
export const K_FACTOR = 32;

/* Round-robin (circle method). Works for odd counts by adding a bye. */
export function createFixtures(ids, legs = 2, phase = 'league', groupId = null) {
  const a = [...ids];
  if (a.length % 2) a.push(null);
  const n = a.length, fixtures = [];
  for (let r = 0; r < n - 1; r++) {
    for (let i = 0; i < n / 2; i++) {
      let p = a[i], q = a[n - 1 - i];
      if (!p || !q) continue;
      if ((r + i) % 2) [p, q] = [q, p];
      for (let leg = 0; leg < legs; leg++) {
        fixtures.push({ a: leg ? q : p, b: leg ? p : q, round: leg * (n - 1) + r + 1, leg: leg + 1, slot: i, phase, groupId });
      }
    }
    a.splice(1, 0, a.pop());
  }
  return fixtures.sort((x, y) => x.round - y.round || x.slot - y.slot);
}

export function tally(matches, ids, perGroup, nameOf = id => id) {
  const map = new Map(ids.map(id => [id, { id, p: 0, w: 0, d: 0, l: 0, sc: 0, con: 0, diff: 0, pts: 0 }]));
  for (const m of matches) {
    if (m.status !== 'done' || !map.has(m.a) || !map.has(m.b)) continue;
    if (perGroup && m.phase !== 'group') continue;
    if (!perGroup && m.phase === 'knockout') continue;
    const a = map.get(m.a), b = map.get(m.b);
    a.p++; b.p++;
    a.sc += m.scoreA; a.con += m.scoreB; b.sc += m.scoreB; b.con += m.scoreA;
    if (m.scoreA > m.scoreB) { a.w++; b.l++; a.pts += 3; }
    else if (m.scoreA < m.scoreB) { b.w++; a.l++; b.pts += 3; }
    else { a.d++; b.d++; a.pts++; b.pts++; }
  }
  return [...map.values()]
    .map(r => ({ ...r, diff: r.sc - r.con }))
    .sort((a, b) => b.pts - a.pts || b.diff - a.diff || b.sc - a.sc || String(nameOf(a.id)).localeCompare(String(nameOf(b.id)), 'tr'));
}

export function rankings(season, groupId = null, nameOf) {
  if (!season) return [];
  const ids = groupId ? (season.groups.find(g => g.id === groupId)?.players || []) : season.players;
  const games = groupId ? season.matches.filter(m => m.groupId === groupId) : season.matches.filter(m => m.phase === 'league');
  return tally(games, ids, !!groupId, nameOf);
}

/* Elo over every finalized match of every season, in finalization order. */
export function ratings(playerIds, seasons) {
  const map = new Map(playerIds.map(id => [id, START_ELO]));
  const games = seasons.flatMap(s => s.matches)
    .filter(m => m.status === 'done' && m.a && m.b)
    .sort((a, b) => (a.finalizedAt || 0) - (b.finalizedAt || 0) || String(a.id).localeCompare(String(b.id)));
  for (const m of games) {
    const ra = map.get(m.a) ?? START_ELO, rb = map.get(m.b) ?? START_ELO;
    const expected = 1 / (1 + Math.pow(10, (rb - ra) / 400));
    const result = m.scoreA > m.scoreB ? 1 : m.scoreA < m.scoreB ? 0 : 0.5;
    const delta = K_FACTOR * (result - expected);
    map.set(m.a, ra + delta);
    map.set(m.b, rb - delta);
  }
  return map;
}

export function groupSizes(n, pref) {
  let count = Math.max(2, Math.round(n / pref));
  while (Math.floor(n / count) < 3 && count > 2) count--;
  return Array.from({ length: count }, (_, i) => Math.floor(n / count) + (i < n % count ? 1 : 0));
}

function shuffle(list, rng) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/* strategy: 'pots' (snake draft over Elo, balanced groups), 'bands' (similar Elo together), 'random'. */
export function createCupGroups(ids, strategy, size, eloMap = new Map(), rng = Math.random) {
  const sizes = groupSizes(ids.length, size);
  const sorted = [...ids].sort((a, b) => (eloMap.get(b) ?? START_ELO) - (eloMap.get(a) ?? START_ELO) || String(a).localeCompare(String(b)));
  const groups = sizes.map((n, i) => ({ id: 'g' + (i + 1), name: String.fromCharCode(65 + i) + ' Grubu', players: [], capacity: n }));
  if (strategy === 'bands' || strategy === 'random') {
    const order = strategy === 'random' ? shuffle(sorted, rng) : sorted;
    let offset = 0;
    for (const g of groups) { g.players = order.slice(offset, offset + g.capacity); offset += g.capacity; }
  } else {
    let pos = 0, slot = 0;
    while (pos < sorted.length) {
      const open = groups.filter(g => g.players.length < g.capacity);
      for (const g of slot % 2 ? [...open].reverse() : open) if (pos < sorted.length) g.players.push(sorted[pos++]);
      slot++;
    }
  }
  return groups.map(({ id, name, players }) => ({ id, name, players }));
}

/* Everything the server needs to create a season: stage, groups and the fixture list. */
export function planSeason({ format, ids, legs = 2, strategy = 'pots', size = 5, eloMap, rng }) {
  if (format === 'league') return { stage: 'league', groups: [], matches: createFixtures(ids, legs, 'league') };
  const groups = createCupGroups(ids, strategy, size, eloMap, rng);
  return { stage: 'groups', groups, matches: groups.flatMap(g => createFixtures(g.players, 1, 'group', g.id)) };
}

export const bracketRoundCount = size => Math.log2(size);

/* Seeds the knockout from group standings. Returns {bracket, matches} for the server to store. */
export function planKnockout(season, nameOf) {
  if (season.format !== 'cup' || season.stage !== 'groups') throw new Error('Bu aşamada eleme oluşturulamaz.');
  if (season.matches.some(m => m.phase === 'group' && m.status !== 'done')) throw new Error('Tüm grup maçları sonuçlanmadan eleme eşleşmeleri oluşturulamaz.');
  const per = season.groups.map(g => ({ g, rank: rankings(season, g.id, nameOf) }));
  const G = per.length;
  const size = (2 * G <= 16 && 3 * G >= 16) ? 16 : Math.pow(2, Math.floor(Math.log2(G * 2)));
  const candidates = [];
  let pos = 0;
  while (candidates.length < size && pos < Math.max(...per.map(x => x.rank.length))) {
    for (const x of per) {
      const row = x.rank[pos];
      if (row) candidates.push({ ...row, groupId: x.g.id, pos: pos + 1, ppg: row.p ? row.pts / row.p : 0, dpg: row.p ? row.diff / row.p : 0 });
    }
    // Same finishing position is ordered by points per game, then differential per game.
    const fresh = per.filter(x => x.rank[pos]).length;
    const prior = candidates.slice(0, candidates.length - fresh);
    const tier = candidates.slice(prior.length).sort((a, b) => b.ppg - a.ppg || b.dpg - a.dpg || b.sc - a.sc);
    candidates.splice(0, candidates.length, ...prior, ...tier);
    pos++;
  }
  const chosen = candidates.slice(0, size), pairs = [];
  for (let i = 0; i < size / 2; i++) pairs.push([chosen[i], chosen[size - 1 - i]]);
  // Avoid same-group meetings in the first knockout round where a swap allows it.
  for (let i = 0; i < pairs.length; i++) if (pairs[i][0].groupId === pairs[i][1].groupId) {
    for (let j = i + 1; j < pairs.length; j++) if (pairs[i][0].groupId !== pairs[j][1].groupId && pairs[j][0].groupId !== pairs[i][1].groupId) {
      [pairs[i][1], pairs[j][1]] = [pairs[j][1], pairs[i][1]];
      break;
    }
  }
  const matches = [];
  for (let r = 0; r < bracketRoundCount(size); r++) for (let k = 0; k < size / Math.pow(2, r + 1); k++) {
    const pair = r === 0 ? pairs[k] : null;
    matches.push({ a: pair?.[0]?.id || null, b: pair?.[1]?.id || null, round: r, slot: k, phase: 'knockout' });
  }
  return {
    bracket: { size, qualifiers: chosen.map(x => x.id), snapshot: chosen.map(x => ({ id: x.id, group: x.groupId, finish: x.pos, ppg: x.ppg })) },
    matches
  };
}

export const knockoutLabel = (round, size) => {
  const remain = (size || 16) / Math.pow(2, round);
  return remain === 2 ? 'Final' : remain === 4 ? 'Yarı final' : remain === 8 ? 'Çeyrek final' : remain === 16 ? 'Son 16' : 'Eleme turu ' + (round + 1);
};

/* Usernames: shown everywhere and used to log in. Turkish letters are allowed but
   fold to ASCII for uniqueness and the login key, so "Şule" and "sule" are the same account.
   The same rule lives in SQL (public.username_key / public.valid_username). */
const FOLD = { 'Ç': 'C', 'Ğ': 'G', 'İ': 'I', 'Ö': 'O', 'Ş': 'S', 'Ü': 'U', 'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u' };
export const usernameKey = name => String(name).replace(/[ÇĞİÖŞÜçğıöşü]/g, ch => FOLD[ch]).toLowerCase();
export const USERNAME_RULE = '3-20 karakter, boşluksuz; harf, rakam ve ! ? . _ - gibi işaretler kullanılabilir.';
export function validUsername(name) {
  return /^[!-~ÇĞİÖŞÜçğıöşü]{3,20}$/.test(name) && /[A-Za-z0-9ÇĞİÖŞÜçğıöşü]/.test(name);
}
/* Email local part for a username key (public.login_local in SQL). Plain keys stay as they are;
   keys with symbols are hex-encoded behind "h-" so they are always a valid email address. */
export function loginLocal(key) {
  if (/^[a-z0-9_]+(\.[a-z0-9_]+)*$/.test(key)) return key;
  return 'h-' + [...new TextEncoder().encode(key)].map(b => b.toString(16).padStart(2, '0')).join('');
}
