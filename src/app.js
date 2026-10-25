/* SJ Kelimelik UI. Data lives in Supabase (src/api.js); league maths in src/engine.js.
   Every write goes through a server function that re-checks permissions, so the checks
   here only decide what to show. */
import * as api from './api.js';
import { ratings, rankings, planSeason, planKnockout, knockoutLabel, START_ELO, validUsername, usernameKey, normalizeUsername, USERNAME_RULE } from './engine.js';

const THEME_KEY = 'sj-kelimelik-theme';
const SEASON_KEY = 'sj-kelimelik-season';

let data = { players: [], seasons: [], profiles: [], audits: [] };
let session = null, me = null, loaded = false, busy = false, eloCache = null;
let view = 'home', fixtureFilter = null, fixturePlayer = 'all', membersOpen = false;
let activeSeasonId = (() => { try { return localStorage.getItem(SEASON_KEY); } catch (e) { return null; } })();

// ------------------------------------------------------------------ small helpers
const $ = (q, root = document) => root.querySelector(q);
const $$ = (q, root = document) => [...root.querySelectorAll(q)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[x]));
const fmt = n => new Intl.NumberFormat('tr-TR').format(n);
const initials = name => String(name).replace(/[_.]/g, ' ').trim().split(/\s+/).slice(0, 2).map(x => x[0]?.toLocaleUpperCase('tr') || '').join('');
const longDate = t => new Date(t).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const player = id => data.players.find(p => p.id === id);
const nickname = id => player(id)?.username || 'Belirlenecek';
/* Real name + graduation year ("Alp Aras '15"). Only approved members can load these. */
const gradLabel = y => (y ? `'${String(y).slice(-2)}` : '');
const personDetails = p => [p?.realName, gradLabel(p?.gradYear)].filter(Boolean).join(' ');
const nameCell = id => { const d = personDetails(player(id)); return `<span class="name-stack">${esc(nickname(id))}${d ? `<span class="person-sub">${esc(d)}</span>` : ''}</span>`; };
const yearField = (id, value) => `<div class="field"><label for="${id}">Mezuniyet yılı (isteğe bağlı)</label><input class="input" id="${id}" name="gradYear" type="number" inputmode="numeric" min="1950" max="2040" placeholder="ör. 2015" value="${esc(value || '')}"></div>`;
const missingDetails = () => me?.status === 'approved' && (!me.real_name || !me.grad_year);
const profileNudge = () => missingDetails() ? `<div class="notice mb flex between wrap"><span>${icon('user', 15)} Profilinizi tamamlayın: gerçek adınızı ve mezuniyet yılınızı ekleyin, üyeler sizi tanısın.</span><button class="btn small" data-action="account">Profili düzenleyin</button></div>` : '';
const isAdmin = () => !!(me?.is_admin && me.status === 'approved');
const myPlayerId = () => (me?.status === 'approved' ? me.player_id : null);
const activeSeason = () => data.seasons.find(s => s.id === activeSeasonId) || data.seasons[data.seasons.length - 1];
const allMatches = () => data.seasons.flatMap(s => s.matches);
const matchById = id => { for (const s of data.seasons) { const m = s.matches.find(x => x.id === id); if (m) return { m, s }; } return null; };
const elo = () => eloCache ||= ratings(data.players.map(p => p.id), data.seasons);
const integerRating = id => Math.round(elo().get(id) ?? START_ELO);
const completedCount = s => s.matches.filter(m => m.status === 'done').length;
const seasonProgress = s => ({ total: s.matches.length, done: completedCount(s), percent: s.matches.length ? Math.round(100 * completedCount(s) / s.matches.length) : 0 });
const winnerOf = m => m.status === 'done' ? (m.scoreA > m.scoreB ? m.a : m.b) : null;

function theme() { return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'; }
function toggleTheme() { const next = theme() === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; try { localStorage.setItem(THEME_KEY, next); } catch (e) {} render(); }
function themeButton() { const dark = theme() === 'dark', label = dark ? 'Açık temaya geçin' : 'Koyu temaya geçin'; return `<button type="button" class="theme-switch" data-action="toggleTheme" aria-label="${label}" title="${label}"><span aria-hidden="true">${dark ? '☀' : '☾'}</span><span class="theme-text">${dark ? 'Açık tema' : 'Koyu tema'}</span></button>`; }
function rememberSeason(id) { activeSeasonId = id; try { localStorage.setItem(SEASON_KEY, id); } catch (e) {} }

const crest = () => api.crestUrl
  ? `<img class="crest-img" src="${esc(api.crestUrl)}" alt="Saint-Joseph geleneksel arması" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'crest-fallback',textContent:'SJ'}))">`
  : '<span class="crest-fallback">SJ</span>';

const icoPaths = {
  home: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M7 15l4-4 3 3 4-5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-8M22 20V7"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 19v-2a6 6 0 0112 0v2M17 6a3 3 0 010 6M19 19v-2a6 6 0 00-2-4"/>',
  archive: '<rect x="3" y="4" width="18" height="6" rx="1"/><path d="M5 10v10h14V10M10 15h4"/>',
  settings: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 9h8M8 15h8M11 6v6M15 12v6"/>',
  right: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  trophy: '<path d="M8 4h8v7a4 4 0 01-8 0V4ZM8 6H4v3a4 4 0 004 4M16 6h4v3a4 4 0 01-4 4M12 15v4M8 21h8"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  refresh: '<path d="M20 8a8 8 0 00-14-2L4 8m0-5v5h5M4 16a8 8 0 0014 2l2-2m0 5v-5h-5"/>',
  shield: '<rect x="5" y="4" width="14" height="16" rx="2"/><path d="m9 12 2 2 4-4"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a7 7 0 0114 0v1"/>'
};
const icon = (name, sz = 19) => `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icoPaths[name] || icoPaths.info}</svg>`;

function notify(message) { const t = $('#toast'); if (!t) return; t.textContent = message; t.classList.add('visible'); clearTimeout(notify.timer); notify.timer = setTimeout(() => t.classList.remove('visible'), 3600); }

const stateName = s => ({ scheduled: 'Oynanacak', pending: 'Onay bekliyor', disputed: 'İtiraz edildi', done: 'Tamamlandı', waiting: 'Eşleşme bekleniyor' })[s] || s;
const statusBadge = s => `<span class="badge ${s === 'done' ? 'green' : s === 'pending' ? 'gold' : s === 'disputed' ? 'red' : ''}">${esc(stateName(s))}</span>`;
/* Kelimelik games run in parallel, so there are no game weeks: league matches are labelled by meeting
   (first match / rematch), group matches by group. Only knockout rounds are sequential. */
const phaseLabel = (m, s) => m.phase === 'group' ? (s.groups.find(g => g.id === m.groupId)?.name || 'Grup')
  : m.phase === 'knockout' ? knockoutLabel(m.round, s.bracket?.size)
  : s.legs === 2 ? (m.leg === 2 ? 'Rövanş' : 'İlk maç') : 'Lig maçı';
const opponentOf = (m, pid) => (m.a === pid ? m.b : m.a);
/* Order for open games: knockout rounds in order, first meetings before rematches, then by name. */
const playOrder = pid => (x, y) =>
  (x.phase === 'knockout' ? x.round : -1) - (y.phase === 'knockout' ? y.round : -1) || (x.leg || 1) - (y.leg || 1)
  || (pid ? nickname(opponentOf(x, pid)).localeCompare(nickname(opponentOf(y, pid)), 'tr')
          : (nickname(x.a) + nickname(x.b)).localeCompare(nickname(y.a) + nickname(y.b), 'tr'));

// ------------------------------------------------------------------ data loading
async function refresh() {
  if (session) me = await api.myProfile(session.user.id);
  data = await api.loadAll({ member: me?.status === 'approved', admin: isAdmin() });
  eloCache = null;
  loaded = true;
  if (!data.seasons.some(s => s.id === activeSeasonId)) {
    const live = [...data.seasons].reverse().find(s => s.status === 'live');
    activeSeasonId = (live || data.seasons[data.seasons.length - 1])?.id || null;
  }
  if (view === 'admin' && !isAdmin()) view = 'home';
  render();
}

/* Runs a server action, then reloads. Ignores double clicks while a request is in flight. */
async function run(fn, okMessage) {
  if (busy) return;
  busy = true; document.body.classList.add('busy');
  try {
    const result = await fn();
    closeModal();
    await refresh();
    if (okMessage) notify(typeof okMessage === 'function' ? okMessage(result) : okMessage);
  } catch (e) { notify(e.message || 'İşlem tamamlanamadı.'); console.error(e); }
  finally { busy = false; document.body.classList.remove('busy'); }
}

// ------------------------------------------------------------------ shell
const navItems = [['home', 'Genel Bakış', 'home', 'Özet'], ['fixtures', 'Fikstür', 'calendar', 'Maçlar'], ['standings', 'Puan Durumu', 'chart', 'Puan'], ['players', 'Oyuncular', 'users', 'Oyuncular'], ['seasons', 'Sezonlar', 'archive', 'Sezon'], ['admin', 'Yönetim', 'settings', 'Yönetim']];
const visibleNav = () => navItems.filter(n => n[0] !== 'admin' || isAdmin());
/* What needs this user's attention: results waiting for their confirmation, and for admins,
   accounts waiting for approval plus disputed results. Shown as badges and in the tab title. */
function actionCounts() {
  const pid = myPlayerId(), matches = allMatches();
  const fixtures = pid ? matches.filter(m => m.status === 'pending' && m.pendingBy !== pid && (m.a === pid || m.b === pid)).length : 0;
  const admin = isAdmin() ? data.profiles.filter(p => p.status === 'pending').length + matches.filter(m => m.status === 'disputed').length : 0;
  return { fixtures, admin, total: fixtures + admin };
}
function navButton([key, label, ic, short], mobile = false, counts = {}) {
  const n = counts[key] || 0, badge = n ? `<span class="nav-badge" aria-label="${n} bekleyen işlem">${n > 9 ? '9+' : n}</span>` : '';
  return `<button type="button" data-nav="${key}" class="${view === key ? 'active' : ''}" aria-current="${view === key ? 'page' : 'false'}">${icon(ic, mobile ? 20 : 18)}<span>${mobile ? short : label}</span>${badge}</button>`;
}

function accountButton() {
  if (!session) return `<button type="button" class="btn small" data-action="login">${icon('user', 15)} Giriş yap</button>`;
  return `<button type="button" class="btn secondary small" data-action="account" title="Hesabım">${icon(isAdmin() ? 'shield' : 'user', 15)}<span class="account-name">${esc(me?.username || 'Hesabım')}</span></button>`;
}

function render() {
  const s = activeSeason();
  const counts = actionCounts();
  document.title = (counts.total ? `(${counts.total}) ` : '') + (s?.name ? s.name + ' | ' : '') + 'SJ Kelimelik';
  const footNote = !session ? 'Sonuçları herkes görebilir. Maç sonucu girmek için giriş yapın.'
    : me?.status === 'pending' ? 'Hesabınız yönetici onayı bekliyor.'
    : me?.status === 'rejected' ? 'Hesabınız onaylanmadı.'
    : isAdmin() ? 'Yönetici olarak giriş yaptınız.' : 'Sonuçlar rakip onayıyla kesinleşir.';
  $('#app').innerHTML = `<div class="shell"><aside class="sidebar"><div class="brand"><div class="brand-crest">${crest()}</div><div><strong>SJ Kelimelik</strong></div></div><div><div class="side-label">MENÜ</div><nav class="nav" aria-label="Ana menü">${visibleNav().map(n => navButton(n, false, counts)).join('')}</nav></div><div class="sidebar-foot"><strong>${icon('info', 14)} ${session ? esc(me?.username || '') : 'Ziyaretçi'}</strong>${footNote}</div></aside>
  <main class="main"><header class="topbar"><div class="topbar-left"><span class="mobile-crest">${crest()}</span><div class="topbar-title">SJ KELİMELİK<b>${esc(s?.name || 'Henüz sezon yok')}</b></div><span class="mobile-theme">${themeButton()}</span></div><div class="topbar-right">${themeButton()}${data.seasons.length ? `<label class="sr-only" for="seasonSwitch">Sezon</label><select id="seasonSwitch" class="small-select">${[...data.seasons].reverse().map(x => `<option value="${esc(x.id)}" ${x.id === s?.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : ''}${accountButton()}</div></header>
  <div class="content">${loaded ? pageContent(s) : '<div class="empty">Yükleniyor…</div>'}<div class="footer-note">SJ Kelimelik · Bağımsız topluluk uygulaması, resmî okul hizmeti değildir</div></div></main></div>
  <nav class="mobile-nav" aria-label="Mobil menü">${visibleNav().filter(x => x[0] !== 'players').map(x => navButton(x, true, counts)).join('')}</nav><div id="modalHost"></div>`;
}

function pageContent(s) {
  switch (view) {
    case 'fixtures': return s ? fixturesPage(s) : noSeason();
    case 'standings': return s ? standingsPage(s) : noSeason();
    case 'players': return playersPage();
    case 'seasons': return seasonsPage();
    case 'admin': return isAdmin() ? adminPage(s) : homePage(s);
    default: return homePage(s);
  }
}

const header = (label, title, subtitle, extra = '') => `<div class="page-header"><div><div class="eyebrow">${label}</div><h1>${title}</h1>${subtitle ? `<p>${subtitle}</p>` : ''}</div>${extra}</div>`;
const stat = (label, value, detail) => `<div class="card stat"><div class="kicker">${label}</div><div class="num">${value}</div><div class="muted tiny">${detail}</div></div>`;
const noSeason = () => `${header('SJ KELİMELİK', 'Henüz sezon yok', 'İlk lig veya kupa oluşturulduğunda fikstür ve puan durumu burada görünecek.')}${isAdmin() ? `<button class="btn" data-action="createSeason">${icon('plus', 16)} İlk organizasyonu oluşturun</button>` : accountNotice()}`;

function accountNotice() {
  if (!session) return `<div class="notice mb flex between wrap"><span>Maç sonucu girmek ve onaylamak için giriş yapın. Yeni oyuncular hesap oluşturup yönetici onayı bekler.</span><span class="actions"><button class="btn small" data-action="login">Giriş yap</button><button class="btn secondary small" data-action="signup">Hesap oluştur</button></span></div>`;
  if (me?.status === 'pending') return `<div class="notice warn mb">${icon('lock', 15)} Hesabınız yönetici onayı bekliyor. Onaylandıktan sonra maçlarınızın sonuçlarını girebilirsiniz.</div>`;
  if (me?.status === 'rejected') return `<div class="notice danger mb">Hesabınız onaylanmadı. Bir yöneticiyle iletişime geçin.</div>`;
  return '';
}

// ------------------------------------------------------------------ pages
function matchCard(m, s) {
  const status = m.status === 'done' ? `${fmt(m.scoreA)} : ${fmt(m.scoreB)}` : m.status === 'pending' ? '<span class="badge gold">Onay</span>' : m.status === 'disputed' ? '<span class="badge red">İtiraz</span>' : `<span class="badge">${m.status === 'waiting' ? 'Bekleniyor' : 'Oynanacak'}</span>`;
  const mine = myPlayerId() && [m.a, m.b].includes(myPlayerId());
  return `<button type="button" data-action="match" data-id="${esc(m.id)}" class="match-row ${mine ? 'mine' : ''}"><span class="indicator ${m.status === 'done' ? 'green' : m.status === 'pending' ? 'gold' : ''}"></span><span style="flex:1;min-width:0"><span class="title">${esc(nickname(m.a))} <span class="muted">vs</span> ${esc(nickname(m.b))}</span><span class="meta">${s.id !== activeSeason()?.id ? esc(s.name) + ' · ' : ''}${esc(phaseLabel(m, s))}</span></span><span class="match-right"><span class="result">${status}</span>${icon('chevron', 15)}</span></button>`;
}

function userMatches(s, pid) {
  const prio = m => m.status === 'pending' && m.pendingBy !== pid ? 0 : m.status === 'scheduled' ? 1 : m.status === 'pending' ? 2 : m.status === 'disputed' ? 3 : m.status === 'waiting' ? 4 : 5;
  return s.matches.filter(m => m.a === pid || m.b === pid).sort((a, b) => prio(a) - prio(b) || playOrder(pid)(a, b));
}

function seasonStanding(s, pid) {
  if (s.format === 'league') return rankings(s, null, nickname);
  const g = s.groups.find(x => x.players.includes(pid)) || s.groups[0];
  return g ? rankings(s, g.id, nickname) : [];
}

function recentResults(s, n = 6) {
  const list = s.matches.filter(m => m.status === 'done').sort((a, b) => (b.finalizedAt || 0) - (a.finalizedAt || 0)).slice(0, n);
  return list.length ? list.map(m => matchCard(m, s)).join('') : '<div class="empty">Henüz sonuç yok.</div>';
}

function homePage(s) {
  if (!s) return noSeason();
  const pid = myPlayerId(), playing = pid && s.players.includes(pid), prog = seasonProgress(s);
  const pill = `<span class="season-pill">${s.status === 'finished' ? 'Tamamlandı' : s.format === 'cup' ? 'Kupa devam ediyor' : 'Lig devam ediyor'}</span>`;
  const standing = seasonStanding(s, pid);
  const tableCard = `<div class="card pad"><div class="section-title"><h2>${s.format === 'league' ? 'Puan durumu' : 'Grup sıralaması'}</h2><button class="linkbtn" data-nav="standings">Tamamı ${icon('right', 13)}</button></div>${tableStanding(standing.slice(0, 7), pid, true)}<div class="divider"></div><div class="flex between"><span class="muted tiny">${fmt(prog.done)} / ${fmt(prog.total)} maç tamamlandı</span><b class="tiny">%${prog.percent}</b></div><div class="track mt"><div class="fill" style="width:${prog.percent}%"></div></div></div>`;
  const recentCard = `<div class="card pad"><div class="section-title"><h2>Son sonuçlar</h2><button class="linkbtn" data-nav="fixtures">Tüm fikstür ${icon('right', 13)}</button></div><div class="match-list">${recentResults(s)}</div></div>`;
  const champion = s.status !== 'finished' ? null : s.bracket ? winnerOf(s.matches.find(m => m.phase === 'knockout' && m.round === Math.log2(s.bracket.size) - 1)) : s.format === 'league' ? standing[0]?.id : null;
  const championCard = champion ? `<div class="card hero mb"><div class="kicker">ŞAMPİYON</div><div class="competitor" style="margin-top:12px">${icon('trophy', 26)} ${esc(nickname(champion))}</div></div>` : '';

  if (!playing) {
    const top = [...s.players].sort((a, b) => integerRating(b) - integerRating(a)).slice(0, 5);
    return `${header('GENEL BAKIŞ', esc(s.name), s.format === 'cup' ? 'Gruplar, eleme tablosu ve sonuçlar.' : 'Fikstür, sonuçlar ve puan durumu.', pill)}${accountNotice()}${profileNudge()}
    ${championCard}
    <div class="layout-2 mb"><div class="stack">${recentCard}</div><div class="stack"><div class="layout-3">${stat('OYUNCU', fmt(s.players.length), 'Bu sezonda')}${stat('TAMAMLANAN', fmt(prog.done), fmt(prog.total) + ' maçtan')}${stat('ONAY BEKLEYEN', fmt(s.matches.filter(m => m.status === 'pending' || m.status === 'disputed').length), 'Sonuç')}</div>${tableCard}
    <div class="card pad"><div class="section-title"><h2>Elo liderleri</h2><button class="linkbtn" data-nav="players">Oyuncular ${icon('right', 13)}</button></div>${top.map((id, i) => `<div class="flex between audit clickable" data-action="profile" data-id="${esc(id)}"><span><span class="rank muted">${i + 1}.</span> <b>${esc(nickname(id))}</b></span><b>${integerRating(id)}</b></div>`).join('')}</div></div></div>`;
  }

  const list = userMatches(s, pid), ownDone = list.filter(m => m.status === 'done').length;
  const toConfirm = list.filter(m => m.status === 'pending' && m.pendingBy !== pid);
  const open = list.filter(m => m.status === 'scheduled');
  const upcoming = list.filter(m => m.status !== 'done' && !toConfirm.includes(m));
  const rank = standing.findIndex(x => x.id === pid) + 1, primary = toConfirm[0];
  const hero = primary
    ? `<div class="card hero"><div class="hero-header"><span class="kicker">Onayınızı bekleyen maç${toConfirm.length > 1 ? ` · ${toConfirm.length} adet` : ''}</span><span class="badge dark">${esc(phaseLabel(primary, s))}</span></div><div class="hero-vs"><div class="competitor"><small>${primary.a === pid ? 'SİZ' : 'RAKİBİNİZ'}</small>${esc(nickname(primary.a))}</div><span class="vs">vs</span><div class="competitor" style="text-align:right"><small>${primary.b === pid ? 'SİZ' : 'RAKİBİNİZ'}</small>${esc(nickname(primary.b))}</div></div><div class="hero-foot"><span class="hero-meta">Rakibiniz ${primary.pendingScore?.a} : ${primary.pendingScore?.b} sonucunu girdi</span><button class="btn" data-action="match" data-id="${esc(primary.id)}">Sonucu inceleyin ${icon('right', 16)}</button></div></div>`
    : `<div class="card hero"><div class="kicker">SIRADAKİ OYUNLARINIZ</div><h2>${open.length ? `${fmt(open.length)} maçınız oynanmayı bekliyor` : 'Şimdilik oynanacak maçınız yok.'}</h2><p class="hero-meta">${open.length ? 'Sıra yok: maçlarınızı istediğiniz sırayla oynayın, biten maçın sonucunu girin.' : 'Tamamladığınız maçları fikstürden inceleyebilirsiniz.'}</p>${open.length ? `<div class="hero-foot"><span class="hero-meta">${fmt(ownDone)} / ${fmt(list.length)} maç tamamlandı</span><button class="btn" data-action="myMatches">Maçlarım ${icon('right', 16)}</button></div>` : ''}</div>`;
  const upcomingCard = `<div class="card pad"><div class="section-title"><h2>Sıradaki oyunlarınız</h2><button class="linkbtn" data-action="myMatches">Tümü${upcoming.length ? ` (${upcoming.length})` : ''} ${icon('right', 13)}</button></div><div class="match-list">${upcoming.length ? upcoming.slice(0, 8).map(m => matchCard(m, s)).join('') : '<div class="empty">Başka maç bulunmuyor.</div>'}</div></div>`;
  return `${header('GENEL BAKIŞ', 'Hoş geldiniz, ' + esc(me.username) + '!', 'Sezonla ilgili gelişmeleri buradan takip edebilirsiniz.', pill)}${profileNudge()}${championCard}
  <div class="layout-2 mb"><div class="stack">${hero}${upcomingCard}${recentCard}</div>
  <div class="stack"><div class="layout-3">${stat('ELO PUANINIZ', fmt(integerRating(pid)), 'Başlangıç: 1000')}${stat('SIRALAMANIZ', rank ? '#' + rank : '−', s.format === 'cup' ? 'Grup sırası' : 'Lig sırası')}${stat('MAÇLARINIZ', fmt(ownDone), fmt(list.length) + ' toplam')}</div>${tableCard}</div></div>`;
}

function tableStanding(rows, userId, compact = false) {
  if (!rows.length) return '<div class="empty">Henüz sonuç yok.</div>';
  return `<div class="table-scroll"><table class="table"><thead><tr><th>Oyuncu</th><th>O</th><th>G</th>${compact ? '' : '<th>B</th><th>M</th>'}<th>AV</th><th>P</th></tr></thead><tbody>${rows.map((x, i) => `<tr class="clickable ${x.id === userId ? 'me' : ''}" data-action="profile" data-id="${esc(x.id)}"><td class="name"><span class="rank">${i + 1}.</span>${nameCell(x.id)}</td><td>${x.p}</td><td>${x.w}</td>${compact ? '' : `<td>${x.d}</td><td>${x.l}</td>`}<td>${x.diff > 0 ? '+' : ''}${x.diff}</td><td class="points">${x.pts}</td></tr>`).join('')}</tbody></table></div>`;
}

function fixturesPage(s) {
  const pid = myPlayerId(), playing = pid && s.players.includes(pid);
  const options = playing ? ['mine', 'all', 'pending', 'done'] : ['all', 'pending', 'done'];
  const filter = options.includes(fixtureFilter) ? fixtureFilter : options[0];
  let matches = [...s.matches];
  if (filter === 'mine') matches = matches.filter(m => m.a === pid || m.b === pid);
  else if (filter === 'pending') matches = matches.filter(m => ['pending', 'disputed'].includes(m.status));
  else if (filter === 'done') matches = matches.filter(m => m.status === 'done');
  if (fixturePlayer !== 'all') matches = matches.filter(m => m.a === fixturePlayer || m.b === fixturePlayer);
  const filterNames = { mine: 'Maçlarım', all: 'Tüm maçlar', pending: 'Onay bekleyen', done: 'Tamamlanan' };
  const people = [...s.players].filter(id => !(filter === 'mine' && id === pid)).sort((a, b) => nickname(a).localeCompare(nickname(b), 'tr'));
  const focus = filter === 'mine' ? pid : fixturePlayer !== 'all' ? fixturePlayer : null;
  const by = (statuses, order) => matches.filter(m => statuses.includes(m.status)).sort(order);
  const sections = [
    ['Onay bekleyen', by(['pending', 'disputed'], (x, y) => (x.pendingBy === pid) - (y.pendingBy === pid) || playOrder(focus)(x, y))],
    ['Oynanacak', by(['scheduled'], playOrder(focus))],
    ['Eşleşme bekleniyor', by(['waiting'], (x, y) => x.round - y.round || x.slot - y.slot)],
    ['Tamamlanan', by(['done'], (x, y) => (y.finalizedAt || 0) - (x.finalizedAt || 0))]
  ].filter(([, list]) => list.length);
  return `${header('FİKSTÜR', 'Maçlar', 'Sabit hafta yok: açık maçlar istenen sırayla oynanır. Sonucu oyunculardan biri girer, rakip onaylar.', `<span class="badge">${fmt(s.matches.length)} maç</span>`)}
  ${accountNotice()}${s.format === 'cup' ? cupInfo(s) : ''}
  <div class="card pad"><div class="filters"><div class="tabs">${options.map(x => `<button class="tab ${filter === x ? 'active' : ''}" data-filter="${x}">${filterNames[x]}</button>`).join('')}</div><label class="field" style="min-width:160px"><span class="sr-only">Oyuncu seç</span><select class="select" id="playerSelect"><option value="all">${filter === 'mine' ? 'Tüm rakipler' : 'Tüm oyuncular'}</option>${people.map(id => `<option value="${esc(id)}" ${fixturePlayer === id ? 'selected' : ''}>${esc(nickname(id))}</option>`).join('')}</select></label></div>
  ${sections.length ? sections.map(([title, list]) => `<div class="round-label">${title} <span class="muted">(${fmt(list.length)})</span></div><div class="match-list">${list.slice(0, 800).map(m => matchCard(m, s)).join('')}</div>`).join('') : '<div class="empty"><strong>Burada maç yok.</strong>Başka bir filtre seçebilirsiniz.</div>'}</div>`;
}

function cupInfo(s) { return `<div class="notice mb">${s.stage === 'groups' ? `Grup aşaması devam ediyor. ${fmt(s.groups.length)} grup var. Bütün grup maçları tamamlanınca eleme tablosu oluşturulur.` : `Grup aşaması tamamlandı. Son ${s.bracket?.size} eleme tablosu açık.`}</div>${s.stage === 'knockout' ? knockoutView(s) : ''}`; }

function knockoutView(s) {
  if (!s.bracket) return '';
  const ko = s.matches.filter(m => m.phase === 'knockout'), rounds = [...new Set(ko.map(m => m.round))].sort((a, b) => a - b);
  return `<div class="card pad mb"><div class="section-title"><h2>Eleme tablosu</h2><span class="badge">Son ${s.bracket.size}</span></div>${rounds.map(r => `<div class="round-label">${knockoutLabel(r, s.bracket.size)}</div><div class="knock-row">${ko.filter(m => m.round === r).map(m => `<button class="knock-card" data-action="match" data-id="${esc(m.id)}" style="text-align:left"><b class="${winnerOf(m) === m.a && m.a ? 'winner' : ''}">${esc(nickname(m.a))}</b><b class="${winnerOf(m) === m.b && m.b ? 'winner' : ''}">${esc(nickname(m.b))}</b><small>${m.status === 'done' ? m.scoreA + ' : ' + m.scoreB : stateName(m.status)}</small></button>`).join('')}</div>`).join('')}</div>`;
}

function standingsPage(s) {
  const pid = myPlayerId();
  if (s.format === 'league') return `${header('SEZON TABLOSU', 'Puan durumu', 'Galibiyet 3 puan, beraberlik 1 puan. Eşitlikte averaj ve atılan puan kullanılır.', `<span class="badge">${s.players.length} oyuncu</span>`)}<div class="card pad mb"><div class="section-title"><h2>${esc(s.name)}</h2><span class="badge green">${completedCount(s)} sonuç</span></div>${tableStanding(rankings(s, null, nickname), pid)}</div>${eloSection(s.players)}`;
  return `${header('KUPA YARIŞI', 'Grup puan durumları', 'Her grubun kendi puan tablosu var. Grup sonrası eleme turları oynanır.', `<span class="badge">${s.groups.length} grup</span>`)}<div class="group-grid mb">${s.groups.map(g => `<div class="card group-card"><div class="section-title"><h3>${esc(g.name)}</h3><span class="badge">${g.players.length} oyuncu</span></div>${tableStanding(rankings(s, g.id, nickname), pid, true)}</div>`).join('')}</div>${s.stage === 'knockout' ? knockoutView(s) : ''}${eloSection(s.players)}`;
}

function eloSection(ids) {
  const sorted = [...ids].sort((a, b) => integerRating(b) - integerRating(a)), pid = myPlayerId();
  return `<div class="card pad"><div class="section-title"><h2>Canlı Elo sıralaması</h2><span class="badge blue">Tüm resmî maçlar</span></div><p class="muted tiny">Herkes 1000 Elo ile başlar. Sadece kesinleşmiş sonuçlar hesaba katılır. Elo, lig puanından bağımsızdır.</p><div class="table-scroll"><table class="table"><thead><tr><th>Oyuncu</th><th>Elo</th><th>1000'e göre</th></tr></thead><tbody>${sorted.map((id, i) => `<tr class="clickable ${id === pid ? 'me' : ''}" data-action="profile" data-id="${esc(id)}"><td class="name"><span class="rank">${i + 1}.</span>${nameCell(id)}</td><td class="points">${integerRating(id)}</td><td>${integerRating(id) >= START_ELO ? '+' : ''}${integerRating(id) - START_ELO}</td></tr>`).join('')}</tbody></table></div></div>`;
}

function playersPage() {
  const sorted = [...data.players].sort((a, b) => integerRating(b.id) - integerRating(a.id)), matches = allMatches();
  return `${header('OYUNCULAR', 'Topluluğun oyuncuları', 'Bir oyuncuyu seçerek profilini, maç geçmişini ve Elo puanını inceleyin.', `<span class="badge">${data.players.length} oyuncu</span>`)}${data.players.length ? `<div class="group-grid">${sorted.map(p => {
    const completed = matches.filter(m => m.status === 'done' && (m.a === p.id || m.b === p.id)).length;
    return `<button type="button" class="card pad player-card" data-action="profile" data-id="${esc(p.id)}"><div class="avatar" style="width:48px;height:48px;font-size:16px">${esc(initials(p.username))}</div><div style="flex:1;min-width:0"><strong>${esc(p.username)}</strong><div class="tiny muted">${personDetails(p) ? esc(personDetails(p)) + ' · ' : ''}${completed} maç</div></div><div style="text-align:right"><strong>${integerRating(p.id)}</strong><div class="tiny muted">Elo</div></div></button>`;
  }).join('')}</div>` : '<div class="empty">Henüz oyuncu yok.</div>'}`;
}

function seasonsPage() {
  const join = !session ? `<p>Hesap oluşturun; yönetici onayından sonra yeni sezonların kadrosuna eklenebilirsiniz.</p><button class="btn" data-action="signup">Hesap oluşturun ${icon('right', 17)}</button>`
    : me?.status === 'pending' ? '<p>Hesabınız oluşturuldu ve yönetici onayı bekliyor. Onaylandığınızda sezon kadrolarına eklenebilirsiniz.</p>'
    : me?.status === 'approved' ? '<p>Hesabınız onaylı. Yöneticiler yeni sezonu oluştururken kadroya sizi ekleyebilir.</p>'
    : '<p>Hesabınız onaylanmadı. Bir yöneticiyle iletişime geçin.</p>';
  return `${header('TOPLULUK', 'Sezonlar ve katılım', 'Ligler, kupalar ve geçmiş sezonlar aynı yerde korunur.', isAdmin() ? `<button class="btn" data-action="createSeason">${icon('plus', 16)} Yeni organizasyon</button>` : '')}
  <div class="register-cover mb"><div class="card special"><div class="eyebrow">KATILIM</div><h2>Bir sonraki sezona katılın.</h2>${join}</div><div class="card pad"><div class="section-title"><h2>Topluluk</h2>${icon('users')}</div><div class="flex between"><b>Toplam oyuncu</b><b>${data.players.length}</b></div><div class="flex between mt"><b>Kaydedilen sezon</b><b>${data.seasons.length}</b></div><div class="flex between mt"><b>Tamamlanan maç</b><b>${fmt(allMatches().filter(m => m.status === 'done').length)}</b></div></div></div>
  <div class="section-title"><h2>Sezon arşivi</h2></div><div class="season-list">${data.seasons.length ? [...data.seasons].reverse().map(s => { const x = seasonProgress(s); return `<div class="card season-item"><div><strong>${esc(s.name)}</strong><div class="muted">${s.format === 'league' ? (s.legs === 1 ? 'Tek devre' : 'Çift devre') + ' / lig' : 'Grup + eleme / kupa'} · ${s.players.length} oyuncu · ${x.done}/${x.total} maç</div></div><div class="actions"><span class="badge ${s.status === 'finished' ? 'green' : 'gold'}">${s.status === 'finished' ? 'Tamamlandı' : 'Devam ediyor'}</span><button class="btn secondary small" data-action="selectSeason" data-id="${esc(s.id)}">Aç ${icon('right', 14)}</button></div></div>`; }).join('') : '<div class="empty">Henüz sezon yok.</div>'}</div>`;
}

function adminPage(s) {
  const pending = data.profiles.filter(p => p.status === 'pending');
  const issues = data.seasons.flatMap(x => x.matches.filter(m => ['pending', 'disputed'].includes(m.status)).map(m => [m, x]))
    .sort((a, b) => (a[0].status === 'disputed' ? 0 : 1) - (b[0].status === 'disputed' ? 0 : 1));
  const groupDone = s?.format === 'cup' && s.stage === 'groups' && s.matches.filter(m => m.phase === 'group').every(m => m.status === 'done');
  const members = data.profiles.filter(p => p.status === 'approved');
  return `${header('YÖNETİM', 'Yönetici paneli', 'Hesaplar, müsabakalar ve sonuç incelemeleri.', `<button class="btn" data-action="createSeason">${icon('plus', 16)} Yeni organizasyon</button>`)}
  <div class="layout-3 mb">${stat('ONAY BEKLEYEN', pending.length, 'Hesap başvurusu')}${stat('SONUÇ İŞLEMLERİ', issues.length, 'Onay veya itiraz')}${stat('TAMAMLANAN', s ? completedCount(s) : 0, 'Bu sezondaki maçlar')}</div>
  <div class="layout-2 mb"><div class="stack">
   <div class="card pad"><div class="section-title"><h2>Hesap başvuruları</h2><span class="badge">${pending.length} bekleyen</span></div>${pending.length ? pending.map(p => `<div class="season-item row-line"><div><strong>${esc(p.username)}</strong><div class="tiny muted">${p.real_name ? esc(p.real_name) + ' · ' : ''}${longDate(p.created_at)}</div></div><div class="actions"><button class="btn soft small" data-action="approveProfile" data-id="${esc(p.id)}">Onayla</button><button class="btn secondary small" data-action="rejectProfile" data-id="${esc(p.id)}">Reddet</button></div></div>`).join('') : '<div class="empty">Yeni başvuru bulunmuyor.</div>'}</div>
   <div class="card pad"><div class="section-title"><h2>Sonuç onayları ve itirazlar</h2><span class="badge gold">${issues.length}</span></div><div class="match-list">${issues.length ? issues.map(([m, x]) => matchCard(m, x)).join('') : '<div class="empty">İncelenecek maç bulunmuyor.</div>'}</div></div>
   <div class="card pad"><div class="section-title"><h2>Üyeler</h2><span class="actions"><span class="badge">${members.length}</span><button class="btn secondary small" data-action="toggleMembers" aria-expanded="${membersOpen}">${membersOpen ? 'Gizle' : 'Göster'}</button></span></div>${membersOpen ? members.map(p => `<div class="season-item row-line"><div><strong>${esc(p.username)}</strong> ${p.is_admin ? '<span class="badge blue">Yönetici</span>' : ''}<div class="tiny muted">${[p.real_name, p.grad_year && p.grad_year + ' mezunu'].filter(Boolean).map(esc).join(' · ') || 'Bilgi girilmedi'}</div></div><button class="btn secondary small" data-action="manageMember" data-id="${esc(p.id)}">Yönet</button></div>`).join('') : '<p class="muted tiny mb0">Yetki ve şifre işlemleri için listeyi açıp bir üyeyi seçin.</p>'}</div>
  </div>
  <div class="stack"><div class="card pad"><h2 style="margin-top:0">Sezon işlemleri</h2>${s ? `<p class="muted">Aktif sezon: <b>${esc(s.name)}</b></p>` : ''}<div class="stack">${groupDone ? `<button class="btn block" data-action="createBracket">${icon('trophy', 16)} Eleme tablosunu oluşturun</button>` : ''}<button class="btn secondary block" data-action="addPlayer">${icon('plus', 16)} Hesapsız oyuncu ekleyin</button><button class="btn secondary block" data-action="exportData">JSON yedeğini dışa aktarın</button>${s ? `<button class="btn secondary block danger-text" data-action="deleteSeason" data-id="${esc(s.id)}">Bu sezonu silin</button>` : ''}</div></div>
  <div class="card pad"><div class="section-title"><h2>Son işlemler</h2>${icon('archive', 17)}</div>${data.audits.length ? data.audits.slice(0, 12).map(a => `<div class="audit"><div class="audit-label">${esc(a.action)}</div><div class="muted">${esc(a.actor_name || 'Sistem')} · ${longDate(a.at)}</div></div>`).join('') : '<div class="empty">Henüz işlem yok.</div>'}</div></div></div>`;
}

// ------------------------------------------------------------------ modals
function modal(content, large = false) { const host = $('#modalHost'); host.innerHTML = `<div class="modal-overlay" id="overlay"><section role="dialog" aria-modal="true" aria-label="İşlem penceresi" class="modal ${large ? 'large' : ''}">${content}</section></div>`; $('.modal input:not([type=hidden]), .modal select, .modal button:not(.close)')?.focus({ preventScroll: true }); }
function closeModal() { const h = $('#modalHost'); if (h) h.innerHTML = ''; }
const modalHeader = (title, description = '') => `<div class="modal-head"><div><h2>${title}</h2>${description ? `<div class="muted">${description}</div>` : ''}</div><button type="button" class="close" data-action="closeModal" aria-label="Kapat">×</button></div>`;
const formActions = (label, cancel = 'Vazgeç') => `<div class="form-actions"><button type="button" class="btn secondary" data-action="closeModal">${cancel}</button><button class="btn" type="submit">${label}</button></div>`;

function openAuth(mode = 'login') {
  const signup = mode === 'signup';
  modal(`${modalHeader(signup ? 'Hesap oluşturun' : 'Giriş yapın', signup ? 'Yönetici onayından sonra maç sonuçlarını girebilirsiniz.' : 'Kullanıcı adınız ve şifrenizle.')}
  <div class="tabs mb"><button type="button" class="tab ${signup ? '' : 'active'}" data-action="login">Giriş</button><button type="button" class="tab ${signup ? 'active' : ''}" data-action="signup">Yeni hesap</button></div>
  <form id="${signup ? 'signupForm' : 'loginForm'}"><div class="stack">
   <div class="field"><label for="authUser">Kullanıcı adı</label><input class="input" id="authUser" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="20">${signup ? `<small>Herkese bu ad görünür. Kelimelik kullanıcı adınızı kullanabilirsiniz. ${USERNAME_RULE}</small>` : ''}</div>
   ${signup ? '<div class="field"><label for="authName">Gerçek ad (isteğe bağlı)</label><input class="input" id="authName" name="realName" autocomplete="name" maxlength="80"><small>Yalnızca onaylı üyeler görür.</small></div>' + yearField('authYear') : ''}
   <div class="field"><label for="authPass">Şifre</label><input class="input" id="authPass" name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required minlength="${signup ? 8 : 1}">${signup ? '<small>En az 8 karakter. Şifrenizi unutursanız bir yönetici sıfırlayabilir.</small>' : ''}</div>
   ${signup ? '<div class="field"><label for="authPass2">Şifre (tekrar)</label><input class="input" id="authPass2" name="password2" type="password" autocomplete="new-password" required minlength="8"></div>' : ''}
  </div>${formActions(signup ? 'Hesap oluşturun' : 'Giriş yapın')}</form>`);
}

function openAccount() {
  const p = myPlayerId() && player(myPlayerId());
  const status = me?.status === 'approved' ? '<span class="badge green">Onaylı</span>' : me?.status === 'pending' ? '<span class="badge gold">Onay bekliyor</span>' : '<span class="badge red">Onaylanmadı</span>';
  modal(`${modalHeader('Hesabım ve profilim', 'Kullanıcı adı: <b>' + esc(me?.username) + '</b>')}
  <div class="flex between mb"><span>${status} ${isAdmin() ? '<span class="badge blue">Yönetici</span>' : ''}</span>${p ? `<button class="linkbtn" data-action="profile" data-id="${esc(p.id)}">Oyuncu profilim ${icon('right', 13)}</button>` : ''}</div>
  <form id="accountForm"><div class="field"><label for="accName">Gerçek ad (isteğe bağlı)</label><input class="input" id="accName" name="realName" maxlength="80" value="${esc(me?.real_name || '')}"><small>Yalnızca onaylı üyeler görür. Herkese açık sayfalarda yalnızca kullanıcı adınız görünür.</small></div>
  <div class="mt">${yearField('accYear', me?.grad_year)}</div>
  <div class="form-actions"><button type="button" class="btn secondary" data-action="logout">Çıkış yapın</button><button class="btn" type="submit">Kaydedin</button></div></form>`);
}

const scoreForm = (m, override = false) => `<form id="scoreForm"><input type="hidden" name="match" value="${esc(m.id)}"><input type="hidden" name="override" value="${override ? '1' : ''}"><div class="score-entry"><div class="field"><label for="scoreA">${esc(nickname(m.a))}</label><input class="input" type="number" inputmode="numeric" name="scoreA" id="scoreA" min="0" max="9999" required value="${m.pendingScore?.a ?? m.scoreA ?? ''}" placeholder="000"></div><div class="sep">:</div><div class="field"><label for="scoreB">${esc(nickname(m.b))}</label><input class="input" type="number" inputmode="numeric" name="scoreB" id="scoreB" min="0" max="9999" required value="${m.pendingScore?.b ?? m.scoreB ?? ''}" placeholder="000"></div></div>${formActions((override ? 'Sonucu kesinleştirin' : 'Sonucu onaya gönderin') + ' ' + icon('right', 15))}</form>`;

function openMatch(id) {
  const h = matchById(id); if (!h) return notify('Maç bulunamadı.');
  const { m, s } = h, pid = myPlayerId(), admin = isAdmin();
  const isParticipant = !!pid && [m.a, m.b].includes(pid);
  const canConfirm = m.status === 'pending' && (admin || (isParticipant && m.pendingBy !== pid));
  const resetButton = admin && ['done', 'pending', 'disputed'].includes(m.status) ? `<button class="btn secondary small mt" data-action="resetMatch" data-id="${esc(m.id)}">${icon('refresh', 14)} Sonucu sıfırlayın</button>` : '';
  let body = '';
  if (m.status === 'done') body = `<div class="detail-summary"><div class="kicker">RESMÎ SONUÇ</div><div class="big-score">${m.scoreA} : ${m.scoreB}</div><div class="tiny muted" style="text-align:center">${m.finalizedAt ? longDate(m.finalizedAt) : ''}</div></div>${admin ? `<div class="notice warn mb">Yönetici düzeltmesi puan durumunu ve Elo'yu yeniden hesaplar${m.phase === 'knockout' ? '; kazanan değişirse sonraki turlar sıfırlanır' : ''}.</div>${scoreForm(m, true)}${resetButton}` : '<div class="notice">Bu maçın sonucu iki oyuncu tarafından onaylandı veya yönetici tarafından kesinleştirildi.</div>'}`;
  else if (m.status === 'pending') body = `<div class="detail-summary"><div class="kicker">ÖNERİLEN SONUÇ</div><div class="big-score">${m.pendingScore?.a} : ${m.pendingScore?.b}</div><div class="tiny muted" style="text-align:center">Gönderen: ${esc(nickname(m.pendingBy))}</div></div>${canConfirm ? `<div class="actions mb"><button class="btn" data-action="confirmMatch" data-id="${esc(m.id)}">${icon('check', 16)} Sonucu onaylayın</button><button class="btn secondary" data-action="disputeMatch" data-id="${esc(m.id)}">İtiraz edin</button></div>` : `<div class="notice warn mb">${isParticipant ? 'Rakibinizin onayı bekleniyor.' : 'Rakip oyuncunun onayı bekleniyor.'}</div>`}${admin ? `<div class="divider"></div><h3>Yönetici düzeltmesi</h3>${scoreForm(m, true)}${resetButton}` : ''}`;
  else if (m.status === 'disputed') body = `<div class="notice danger mb">Bu sonuca itiraz edildi. Yönetici incelemesi gerekiyor.</div>${admin ? scoreForm(m, true) + resetButton : '<p class="muted">İnceleme tamamlandığında maç sonucu kesinleşir.</p>'}`;
  else if (m.status === 'waiting') body = '<div class="notice">Bu eleme maçının rakipleri önceki tur tamamlandıktan sonra belli olacak.</div>';
  else if (admin) body = `<div class="notice mb">Yönetici olarak sonucu doğrudan kesinleştirebilirsiniz.</div>${scoreForm(m, true)}`;
  else if (isParticipant) body = `<div class="notice mb">Sonucu siz girin, rakibiniz onaylasın. Onaylanana kadar tablo ve Elo değişmez.</div>${scoreForm(m, false)}`;
  else body = `<div class="notice">Bu maçın sonucunu yalnızca oyunculardan biri veya yönetici girebilir.${session ? '' : ' Oyuncuysanız giriş yapın.'}</div>${session ? '' : '<button class="btn mt" data-action="login">Giriş yapın</button>'}`;
  modal(`${modalHeader('Maç ayrıntısı', esc(s.name) + ' · ' + esc(phaseLabel(m, s)))}<div class="flex between mb"><b>${esc(nickname(m.a))} <span class="muted">vs</span> ${esc(nickname(m.b))}</b>${statusBadge(m.status)}</div>${body}`);
}

function openCreateSeason() {
  if (!isAdmin()) return notify('Yönetici yetkisi gerekiyor.');
  const players = [...data.players].sort((a, b) => a.username.localeCompare(b.username, 'tr'));
  if (players.length < 4) return notify('Organizasyon için en az 4 oyuncu gerekiyor. Önce hesapları onaylayın veya oyuncu ekleyin.');
  const year = new Date().getFullYear();
  modal(`${modalHeader('Yeni organizasyon oluşturun', 'Biçimi seçin, oyuncuları belirleyin, fikstür otomatik oluşturulsun.')}
  <form id="newSeasonForm"><div class="formgrid mb"><div class="field"><label for="seasonName">Organizasyon adı</label><input class="input" id="seasonName" name="name" minlength="3" maxlength="70" required value="${year} Ligi"></div><div class="field"><label for="format">Oyun biçimi</label><select class="select" name="format" id="format"><option value="league" selected>Lig, herkes herkesle</option><option value="cup">Kupa, gruplar + eleme</option></select></div><div class="field" id="legsWrap"><label for="legs">Karşılaşma sayısı</label><select class="select" name="legs" id="legs"><option value="2" selected>İki devre</option><option value="1">Tek devre</option></select></div><div class="field" id="seedWrap" style="display:none"><label for="seedStrategy">Grup oluşturma</label><select class="select" name="seedStrategy" id="seedStrategy"><option value="pots">Elo torbaları, dengeli gruplar</option><option value="bands">Yakın Elo, denk rakipler</option><option value="random">Rastgele kura</option></select></div><div class="field" id="sizeWrap" style="display:none"><label for="groupSize">Hedef grup büyüklüğü</label><select class="select" id="groupSize" name="groupSize"><option value="4">4 kişi</option><option value="5" selected>5 kişi</option><option value="6">6 kişi</option></select></div></div>
  <div class="section-title"><h2>Katılacak oyuncular</h2><button type="button" class="linkbtn" data-action="toggleRoster">Tümünü seç / kaldır</button></div><p class="muted tiny">En az 4 oyuncu seçin. Fikstür oluşturulduktan sonra kadro değiştirilemez.</p><div class="roster" id="roster">${players.map(p => `<label class="check"><input type="checkbox" name="players" value="${esc(p.id)}" checked> ${esc(p.username)}</label>`).join('')}</div>${formActions('Fikstürü oluşturun ' + icon('right', 16), 'İptal')}</form>`, true);
}

function openAddPlayer() {
  modal(`${modalHeader('Hesapsız oyuncu ekleyin', 'Henüz hesabı olmayan veya geçmiş sezonlarda oynamış biri için.')}
  <form id="addPlayerForm"><div class="stack"><div class="field"><label for="apUser">Kullanıcı adı</label><input class="input" id="apUser" name="username" maxlength="20" required autocapitalize="none"><small>${USERNAME_RULE} Kişi daha sonra aynı kullanıcı adıyla hesap açarsa onay sırasında bu oyuncuya bağlanır.</small></div><div class="field"><label for="apName">Gerçek ad (isteğe bağlı)</label><input class="input" id="apName" name="realName" maxlength="80"></div>${yearField('apYear')}</div>${formActions('Oyuncuyu ekleyin')}</form>`);
}

function openApprove(id) {
  const p = data.profiles.find(x => x.id === id); if (!p) return;
  const linked = new Set(data.profiles.filter(x => x.player_id).map(x => x.player_id));
  const free = data.players.filter(x => !linked.has(x.id)).sort((a, b) => a.username.localeCompare(b.username, 'tr'));
  const same = free.find(x => usernameKey(x.username) === p.username_key);
  modal(`${modalHeader('Hesabı onaylayın', '<b>' + esc(p.username) + '</b>' + (p.real_name ? ' · ' + esc(p.real_name) : ''))}
  <form id="approveForm"><input type="hidden" name="profile" value="${esc(p.id)}"><div class="field"><label for="apLink">Oyuncu profili</label><select class="select" id="apLink" name="player"><option value="">Yeni oyuncu oluştur (${esc(p.username)})</option>${free.map(x => `<option value="${esc(x.id)}" ${x === same ? 'selected' : ''}>Mevcut oyuncuya bağla: ${esc(x.username)}</option>`).join('')}</select><small>Bu kişi daha önce hesapsız oyuncu olarak eklendiyse, maç geçmişini korumak için o oyuncuya bağlayın.</small></div>${formActions('Onaylayın')}</form>`);
}

function openMember(id) {
  const p = data.profiles.find(x => x.id === id); if (!p) return;
  const pl = p.player_id && player(p.player_id), self = p.id === me.id;
  modal(`${modalHeader(esc(p.username), p.is_admin ? '<span class="badge blue">Yönetici</span>' : 'Üye')}
  <div class="detail-summary"><div class="flex between"><span class="muted">Gerçek ad</span><b>${esc(p.real_name || '—')}</b></div><div class="flex between mt"><span class="muted">Mezuniyet</span><b>${p.grad_year || '—'}</b></div><div class="flex between mt"><span class="muted">Oyuncu profili</span><b>${pl ? esc(pl.username) : '—'}</b></div><div class="flex between mt"><span class="muted">Katılım</span><b>${longDate(p.created_at)}</b></div></div>
  <div class="stack">${pl ? `<button class="btn secondary block" data-action="profile" data-id="${esc(pl.id)}">${icon('user', 15)} Oyuncu profilini görüntüleyin</button><button class="btn secondary block" data-action="editPlayer" data-id="${esc(pl.id)}">${icon('user', 15)} Ad ve mezuniyet yılını düzenleyin</button>` : ''}${self ? '' : `<button class="btn secondary block" data-action="toggleAdminRole" data-id="${esc(p.id)}">${icon('shield', 15)} ${p.is_admin ? 'Yöneticilikten çıkarın' : 'Yönetici yapın'}</button>`}<button class="btn secondary block" data-action="resetPassword" data-id="${esc(p.id)}">${icon('lock', 15)} Şifre sıfırlayın</button></div>`);
}

function openEditPlayer(id) {
  const p = player(id); if (!p) return;
  modal(`${modalHeader('Oyuncu bilgileri', '<b>' + esc(p.username) + '</b> · yalnızca onaylı üyeler görür')}
  <form id="editPlayerForm"><input type="hidden" name="player" value="${esc(p.id)}"><div class="stack"><div class="field"><label for="epName">Gerçek ad</label><input class="input" id="epName" name="realName" maxlength="80" value="${esc(p.realName || '')}"></div>${yearField('epYear', p.gradYear)}</div>${formActions('Kaydedin')}</form>`);
}

function openResetPassword(id) {
  const p = data.profiles.find(x => x.id === id); if (!p) return;
  const suggestion = Array.from(crypto.getRandomValues(new Uint32Array(10)), n => 'abcdefghjkmnpqrstuvwxyz23456789'[n % 31]).join('');
  modal(`${modalHeader('Şifre sıfırlayın', '<b>' + esc(p.username) + '</b> için yeni şifre')}
  <form id="resetForm"><input type="hidden" name="profile" value="${esc(p.id)}"><div class="field"><label for="newPass">Yeni şifre</label><input class="input" id="newPass" name="password" minlength="8" required value="${suggestion}" autocomplete="off" spellcheck="false"><small>Yeni şifreyi kişiye siz iletin. Giriş yaptıktan sonra değiştirmesi için sizden yeniden sıfırlama isteyebilir.</small></div>${formActions('Şifreyi değiştirin')}</form>`);
}

function openProfile(id) {
  const p = player(id); if (!p) return;
  const history = allMatches().filter(m => m.status === 'done' && [m.a, m.b].includes(id)).sort((a, b) => (b.finalizedAt || 0) - (a.finalizedAt || 0));
  const wins = history.filter(m => winnerOf(m) === id && m.scoreA !== m.scoreB).length, draws = history.filter(m => m.scoreA === m.scoreB).length;
  const seasonOf = m => data.seasons.find(s => s.id === m.seasonId);
  modal(`${modalHeader('Oyuncu profili', 'Topluluk istatistikleri')}<div class="profile-intro mb"><div class="avatar">${esc(initials(p.username))}</div><div style="flex:1;min-width:0"><h2 style="margin:0">${esc(p.username)}</h2>${p.realName || p.gradYear ? `<div class="muted">${[p.realName, p.gradYear && p.gradYear + ' mezunu'].filter(Boolean).map(esc).join(' · ')}</div>` : ''}</div>${p.id === myPlayerId() ? `<button class="btn secondary small" data-action="account">Bilgilerimi düzenleyin</button>` : isAdmin() ? `<button class="btn secondary small" data-action="editPlayer" data-id="${esc(p.id)}">Bilgileri düzenleyin</button>` : ''}</div><div class="layout-3 mb">${stat('ELO', integerRating(id), '1000 başlangıç')}${stat('GALİBİYET', wins, history.length + ' maç')}${stat('MAĞLUBİYET', history.length - wins - draws, draws + ' beraberlik')}</div><div class="section-title"><h2>Son maçlar</h2></div><div class="match-list">${history.length ? history.slice(0, 10).map(m => matchCard(m, seasonOf(m))).join('') : '<div class="empty">Henüz resmî sonuç yok.</div>'}</div>`, true);
}

function downloadData() {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), ...data }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = 'sj-kelimelik-yedek-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ------------------------------------------------------------------ events
function action(name, id) {
  switch (name) {
    case 'closeModal': return closeModal();
    case 'toggleTheme': return toggleTheme();
    case 'login': return openAuth('login');
    case 'signup': return openAuth('signup');
    case 'account': return openAccount();
    case 'logout': return run(async () => { await api.signOut(); session = null; me = null; if (view === 'admin') view = 'home'; }, 'Çıkış yapıldı.');
    case 'createSeason': return openCreateSeason();
    case 'addPlayer': return openAddPlayer();
    case 'match': return openMatch(id);
    case 'profile': return openProfile(id);
    case 'confirmMatch': return run(() => api.respondScore(id, true), 'Maç sonucu onaylandı, puan durumu ve Elo güncellendi.');
    case 'disputeMatch': return run(() => api.respondScore(id, false), 'İtiraz kaydedildi, yönetici incelemesi gerekiyor.');
    case 'resetMatch': return confirm('Bu maçın sonucu silinsin mi? Puan durumu ve Elo yeniden hesaplanır.') && run(() => api.adminResetMatch(id), 'Maç sonucu sıfırlandı.');
    case 'selectSeason': rememberSeason(id); fixturePlayer = 'all'; view = 'home'; return render();
    case 'approveProfile': return openApprove(id);
    case 'rejectProfile': return confirm('Bu hesap reddedilsin mi?') && run(() => api.rejectProfile(id), 'Hesap reddedildi.');
    case 'toggleAdminRole': { const p = data.profiles.find(x => x.id === id); return p && confirm(p.is_admin ? `${p.username} yöneticilikten çıkarılsın mı?` : `${p.username} yönetici yapılsın mı? Tüm yönetici işlemlerini yapabilecek.`) && run(() => api.adminSetAdmin(id, !p.is_admin), 'Yetki güncellendi.'); }
    case 'resetPassword': return openResetPassword(id);
    case 'manageMember': return openMember(id);
    case 'editPlayer': return openEditPlayer(id);
    case 'myMatches': view = 'fixtures'; fixtureFilter = 'mine'; fixturePlayer = 'all'; render(); return window.scrollTo({ top: 0, behavior: 'instant' });
    case 'toggleMembers': membersOpen = !membersOpen; return render();
    case 'toggleRoster': { const checks = $$('input[name="players"]', $('#roster')); const all = checks.every(x => x.checked); checks.forEach(x => { x.checked = !all; }); return; }
    case 'createBracket': {
      const s = activeSeason();
      let plan;
      try { plan = planKnockout(s, nickname); } catch (e) { return notify(e.message); }
      return run(() => api.adminCreateKnockout(s.id, plan), () => { view = 'fixtures'; fixtureFilter = 'all'; fixturePlayer = 'all'; render(); return 'Son ' + plan.bracket.size + ' eleme tablosu hazır.'; });
    }
    case 'exportData': downloadData(); return notify('JSON yedeği indirildi.');
    case 'deleteSeason': {
      const s = data.seasons.find(x => x.id === id);
      if (!s) return;
      const typed = prompt(`"${s.name}" ve tüm maçları kalıcı olarak silinecek. Onaylamak için sezon adını yazın:`);
      if (typed === null) return;
      if (typed.trim() !== s.name) return notify('Sezon adı eşleşmedi, silinmedi.');
      return run(() => api.adminDeleteSeason(id), 'Sezon silindi.');
    }
  }
}

function handleSubmit(e) {
  const f = e.target;
  if (!f.id) return;
  e.preventDefault();
  const d = new FormData(f), str = k => String(d.get(k) ?? '').trim();
  const year = () => { const t = str('gradYear'); if (!t) return null; const n = Number(t); if (!Number.isInteger(n) || n < 1950 || n > 2040) throw Error('Mezuniyet yılı 1950 ile 2040 arasında olmalı (ör. 2015).'); return n; };
  try {
    if (f.id === 'loginForm') {
      return run(async () => { session = await api.signIn(str('username'), String(d.get('password'))); }, () => 'Hoş geldiniz, ' + (me?.username || '') + '!');
    }
    if (f.id === 'signupForm') {
      const username = normalizeUsername(str('username'));
      if (!validUsername(username)) throw Error('Kullanıcı adı geçersiz. ' + USERNAME_RULE);
      if (String(d.get('password')).length < 8) throw Error('Şifre en az 8 karakter olmalı.');
      if (d.get('password') !== d.get('password2')) throw Error('Şifreler eşleşmiyor.');
      return run(async () => { session = await api.signUp(username, String(d.get('password')), str('realName'), year()); }, 'Hesabınız oluşturuldu. Yönetici onayından sonra sonuç girebilirsiniz.');
    }
    if (f.id === 'accountForm') { const y = year(); return run(() => api.updateMyProfile(str('realName'), y), 'Bilgileriniz kaydedildi.'); }
    if (f.id === 'editPlayerForm') { const y = year(); return run(() => api.adminUpdatePlayer(str('player'), str('realName'), y), 'Oyuncu bilgileri kaydedildi.'); }
    if (f.id === 'scoreForm') {
      if (str('scoreA') === '' || str('scoreB') === '') throw Error('İki oyuncunun puanını da girin.');
      const a = Number(str('scoreA')), b = Number(str('scoreB'));
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a > 9999 || b > 9999) throw Error('0 ile 9999 arasında tam sayı girin.');
      const id = str('match');
      return d.get('override') ? run(() => api.adminSetScore(id, a, b), 'Resmî sonuç kaydedildi.') : run(() => api.submitScore(id, a, b), 'Sonuç rakibinizin onayına gönderildi.');
    }
    if (f.id === 'approveForm') return run(() => api.approveProfile(str('profile'), str('player') || null), 'Hesap onaylandı.');
    if (f.id === 'resetForm') return run(() => api.adminResetPassword(str('profile'), String(d.get('password'))), 'Şifre değiştirildi. Yeni şifreyi kişiye iletin.');
    if (f.id === 'addPlayerForm') {
      const username = normalizeUsername(str('username'));
      if (!validUsername(username)) throw Error('Kullanıcı adı geçersiz. ' + USERNAME_RULE);
      const y = year();
      return run(async () => { const pid = await api.adminAddPlayer(username, str('realName')); if (y) await api.adminUpdatePlayer(pid, str('realName'), y); }, 'Oyuncu eklendi.');
    }
    if (f.id === 'newSeasonForm') {
      const ids = [...new Set(d.getAll('players').map(String))].filter(x => player(x));
      if (ids.length < 4) throw Error('Lütfen en az 4 oyuncu seçin.');
      const name = str('name');
      if (name.length < 3) throw Error('Sezon adı en az üç karakter olmalı.');
      const format = d.get('format') === 'cup' ? 'cup' : 'league', legs = Number(d.get('legs')) === 1 ? 1 : 2, size = Number(d.get('groupSize')) || 5;
      const strategy = ['pots', 'bands', 'random'].includes(d.get('seedStrategy')) ? String(d.get('seedStrategy')) : 'pots';
      const plan = planSeason({ format, ids, legs, strategy, size, eloMap: elo() });
      return run(async () => { const sid = await api.adminCreateSeason({ name, format, legs, strategy, ids, plan }); rememberSeason(sid); view = 'fixtures'; fixtureFilter = 'all'; fixturePlayer = 'all'; },
        `Yeni ${format === 'league' ? 'lig' : 'kupa'} fikstürü oluşturuldu: ${plan.matches.length} maç.`);
    }
  } catch (err) { notify(err.message || 'İşlem tamamlanamadı.'); }
}

function change(e) {
  const t = e.target;
  if (t.id === 'seasonSwitch') { rememberSeason(t.value); fixturePlayer = 'all'; render(); }
  else if (t.id === 'playerSelect') { fixturePlayer = t.value; render(); }
  else if (t.id === 'format') { const cup = t.value === 'cup'; $('#legsWrap').style.display = cup ? 'none' : ''; $('#seedWrap').style.display = cup ? '' : 'none'; $('#sizeWrap').style.display = cup ? '' : 'none'; $('#seasonName').value = new Date().getFullYear() + (cup ? ' Kupası' : ' Ligi'); }
}

function setupPage() {
  $('#app').innerHTML = `<div class="content" style="max-width:640px"><div class="card pad mt"><div class="brand-crest" style="width:64px;margin-bottom:12px">${crest()}</div><h1 style="margin-top:0">Kurulum gerekiyor</h1><p class="muted"><code>config.js</code> dosyasına Supabase proje adresini ve anon anahtarını girin. Ayrıntılı adımlar README dosyasında.</p></div></div>`;
}

async function start() {
  document.addEventListener('click', e => {
    const nav = e.target.closest('[data-nav]');
    if (nav) { view = nav.dataset.nav; if (view === 'fixtures') fixturePlayer = 'all'; closeModal(); render(); window.scrollTo({ top: 0, behavior: 'instant' }); return; }
    const filter = e.target.closest('[data-filter]');
    if (filter) { fixtureFilter = filter.dataset.filter; fixturePlayer = 'all'; render(); return; }
    const button = e.target.closest('[data-action]');
    if (button) { action(button.dataset.action, button.dataset.id); return; }
    if (e.target.id === 'overlay') closeModal();
  });
  document.addEventListener('submit', handleSubmit);
  document.addEventListener('change', change);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  if (!api.configured) return setupPage();
  render();
  try {
    session = await api.getSession();
    await refresh();
  } catch (e) { loaded = true; render(); notify(e.message || 'Veriler yüklenemedi.'); console.error(e); }
  api.onAuthChange(async next => {
    if ((next?.user?.id || null) === (session?.user?.id || null)) { session = next; return; }
    session = next; me = null;
    if (!session && view === 'admin') view = 'home';
    try { await refresh(); } catch (e) { notify(e.message); }
  });
  api.subscribe(() => { if (!busy) refresh().catch(console.error); });
  setInterval(async () => {
    if (!isAdmin() || busy || document.visibilityState !== 'visible') return;
    try { if (await api.pendingProfileCount() !== data.profiles.filter(p => p.status === 'pending').length) await refresh(); }
    catch (e) { console.error(e); }
  }, 45000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !busy) refresh().catch(console.error); });
}

start();
