import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixtures, planSeason, planKnockout, ratings, rankings, groupSizes, usernameKey, validUsername, loginLocal } from '../src/engine.js';

const ids = n => Array.from({ length: n }, (_, i) => 'p' + (i + 1));
let seq = 0;
const asSeason = (plan, players, format) => ({
  id: 's', format, stage: plan.stage, players, groups: plan.groups, bracket: null,
  matches: plan.matches.map(m => ({ ...m, id: 'm' + seq++, status: 'scheduled', scoreA: null, scoreB: null }))
});
const finish = (m, a, b) => Object.assign(m, { status: 'done', scoreA: a, scoreB: b, finalizedAt: seq++ });

test('30-player double round robin: 870 matches, every pair twice, 58 per player', () => {
  const f = createFixtures(ids(30), 2);
  assert.equal(f.length, 870);
  assert.equal(f.filter(m => m.a === 'p1' || m.b === 'p1').length, 58);
  const pairs = {};
  for (const m of f) { const k = [m.a, m.b].sort().join('|'); pairs[k] = (pairs[k] || 0) + 1; }
  assert.equal(Object.keys(pairs).length, 435);
  assert.ok(Object.values(pairs).every(x => x === 2));
  assert.ok(f.every(m => m.a && m.b && m.a !== m.b));
});

test('odd player counts get a bye', () => {
  const f = createFixtures(ids(29), 2);
  assert.equal(f.length, 812);
  assert.equal(f.filter(m => m.a === 'p1' || m.b === 'p1').length, 56);
});

test('nobody plays twice in the same round', () => {
  for (const n of [4, 7, 12]) {
    const byRound = {};
    for (const m of createFixtures(ids(n), 2)) for (const p of [m.a, m.b]) {
      const k = m.round + p;
      assert.ok(!byRound[k], `${p} twice in round ${m.round}`);
      byRound[k] = true;
    }
  }
});

test('30-player cup: 6 groups of 5, last 16, champion crowned', () => {
  const players = ids(30);
  const season = asSeason(planSeason({ format: 'cup', ids: players, size: 5, strategy: 'pots' }), players, 'cup');
  assert.equal(season.groups.length, 6);
  assert.ok(season.groups.every(g => g.players.length === 5));
  assert.equal(season.matches.length, 60);
  season.matches.forEach((m, i) => finish(m, 300 + (i * 37) % 120, 280 + (i * 53) % 130));
  const ko = planKnockout(season);
  assert.equal(ko.bracket.size, 16);
  assert.equal(ko.matches.length, 15);
  assert.equal(new Set(ko.bracket.qualifiers).size, 16);
  const firstRound = ko.matches.filter(m => m.round === 0);
  assert.ok(firstRound.every(m => m.a && m.b));
  const groupOf = id => season.groups.find(g => g.players.includes(id)).id;
  assert.equal(firstRound.filter(m => groupOf(m.a) === groupOf(m.b)).length, 0, 'no same-group first-round pairings');
});

test('cup grouping works for 26-30 players with 4/5/6 targets', () => {
  for (const n of [26, 27, 28, 29, 30]) for (const pref of [4, 5, 6]) {
    const players = ids(n);
    const season = asSeason(planSeason({ format: 'cup', ids: players, size: pref, strategy: 'pots' }), players, 'cup');
    assert.ok(season.groups.every(g => g.players.length >= 3), `underfilled ${n}/${pref}`);
    assert.equal(season.groups.reduce((v, g) => v + g.players.length, 0), n);
    season.matches.forEach((m, i) => finish(m, 300 + i % 7, 290 + i % 11));
    const size = planKnockout(season).bracket.size;
    assert.equal(size & (size - 1), 0, 'power of two');
  }
});

test('random draw uses the injected rng; pots spread Elo evenly', () => {
  const players = ids(8);
  let x = 0;
  const a = planSeason({ format: 'cup', ids: players, size: 4, strategy: 'random', rng: () => (x = (x * 9301 + 49297) % 233280) / 233280 });
  assert.deepEqual(a.groups.flatMap(g => g.players).sort(), [...players].sort());
  const elo = new Map(players.map((p, i) => [p, 1200 - i * 20]));
  const pots = planSeason({ format: 'cup', ids: players, size: 4, strategy: 'pots', eloMap: elo });
  assert.deepEqual(pots.groups.map(g => g.players[0]), ['p1', 'p2'], 'top seeds in different groups');
  assert.deepEqual(groupSizes(30, 5), [5, 5, 5, 5, 5, 5]);
});

test('standings use 3/1/0 then differential; Elo is zero-sum from 1000', () => {
  const players = ids(4);
  const s = asSeason(planSeason({ format: 'league', ids: players, legs: 1 }), players, 'league');
  s.matches.forEach(m => finish(m, m.a === 'p1' || m.b === 'p1' ? (m.a === 'p1' ? 400 : 300) : 350, m.a === 'p1' || m.b === 'p1' ? (m.b === 'p1' ? 400 : 300) : 350));
  const table = rankings(s);
  assert.equal(table[0].id, 'p1');
  assert.equal(table[0].pts, 9);
  assert.equal(table[1].pts, 2);
  const elo = ratings(players, [s]);
  assert.ok(elo.get('p1') > 1000);
  assert.ok(Math.abs([...elo.values()].reduce((a, b) => a + b, 0) - 4000) < 1e-9);
});

test('username rules match the SQL rules', () => {
  assert.equal(usernameKey('Şule_İpek'), 'sule_ipek');
  assert.equal(usernameKey('ÇĞÖÜığ'), 'cgouig');
  for (const ok of ['alp', 'Ayşe', 'kelime.ustasi', 'oyuncu_42', 'Kelime!', '@lp', 'a-b', 'neden?', '.alp.']) assert.ok(validUsername(ok), ok);
  for (const bad of ['al', 'a b c', 'x'.repeat(21), '!!!', 'tab\tname', 'emoji😀x']) assert.ok(!validUsername(bad), bad);
  assert.equal(loginLocal('kungfu_manda'), 'kungfu_manda');
  assert.equal(loginLocal('kelime!'), 'h-6b656c696d6521');
  assert.ok(loginLocal('x'.repeat(20) + '').length <= 64 && loginLocal('!'.repeat(19) + 'a').length <= 64, 'always a valid email length');
});
