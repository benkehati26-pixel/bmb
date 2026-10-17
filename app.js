/* BMB · יומן עבודה – Ben Menachem Bari
 * Offline-first PWA backed by Supabase (Auth + Postgres with RLS + Edge Functions).
 * SECURITY: the only key in this file is the PUBLIC Supabase publishable key (safe to expose; RLS protects data).
 * The Gemini key and the service_role key live only as Supabase Edge Function secrets.
 */
'use strict';

const APP_VERSION = '1.3.0';
const SB_URL = 'https://ufgmhbtimmgumeufwfxq.supabase.co';
const SB_KEY = 'sb_publishable_PHuOoNjPXQ8kEhXzGEKvhA_MGpInny-'; // public publishable key
const USER_DOMAIN = 'bmb.local';
const LS_LEGACY_ENTRIES = 'bmb.entries.v1'; // v1.1 (pre-login) data – offered for one-time upload
const LS_LEGACY_LOGO = 'bmb.companyLogo.v1';
const LS_SETTINGS = 'bmb.settings.v1';      // per-device personal prefs (foreman name)
const LS_COMPANY = 'bmb.company.v2';        // cache of server app_settings
const LS_PROFILE = 'bmb.profile.v2';        // cache of last signed-in profile (offline start)
const LS_AUTH = 'bmb.auth';                 // supabase-js session storage key
const AI_LIMIT_DEFAULT = 50;
const CREW_TYPES = ['פועלים', 'קבלן משנה', 'ציוד', 'אחר'];

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jget = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
const jset = (k, v) => localStorage.setItem(k, JSON.stringify(v));

const sb = window.supabase.createClient(SB_URL, SB_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: LS_AUTH },
});

/* ---------------- session state ---------------- */
let me = null;          // { id, username, display_name, role, ai_enabled, disabled }
const uid = () => me && me.id;
const isAdmin = () => !!me && me.role === 'admin';
const ukey = (k) => `bmb.u.${uid()}.${k}`;

/* ---------------- storage (per-user local cache + pending queue) ---------------- */
const store = {
  entries() { return uid() ? jget(ukey('entries'), {}) : {}; },
  saveAll(obj) { if (uid()) jset(ukey('entries'), obj); },
  get(date) { return this.entries()[date] || null; },
  put(entry) { const all = this.entries(); all[entry.date] = entry; this.saveAll(all); pending.mark(entry.date, 'put'); },
  putMany(list) { const all = this.entries(); list.forEach((e) => { all[e.date] = e; }); this.saveAll(all); list.forEach((e) => pending.mark(e.date, 'put')); },
  del(date) { const all = this.entries(); delete all[date]; this.saveAll(all); pending.mark(date, 'del'); },
  settings() {
    const local = jget(LS_SETTINGS, {});
    return { foreman: local.foreman ?? (me && me.display_name) ?? '', company: company.get().company_name || '' };
  },
  saveSettings(patch) { const cur = jget(LS_SETTINGS, {}); jset(LS_SETTINGS, Object.assign(cur, { foreman: patch.foreman ?? cur.foreman })); },
};

const pending = {
  all() { return uid() ? jget(ukey('pending'), {}) : {}; },
  count() { return Object.keys(this.all()).length; },
  mark(date, op) { const p = this.all(); p[date] = { op, t: Date.now() }; jset(ukey('pending'), p); scheduleSync(); updateSyncBadge(); },
  clear(date, t) { const p = this.all(); if (p[date] && p[date].t === t) { delete p[date]; jset(ukey('pending'), p); } },
};

/** Company settings (name + logo) – stored server-side in app_settings (admin-only write), cached locally. */
const company = {
  get() { return jget(LS_COMPANY, { company_name: '', logo: null }); },
  set(v) { jset(LS_COMPANY, v); },
};
const companyLogo = { get() { return company.get().logo || null; } }; // used by excel.js / print

// Remove the old per-device Anthropic key (v1.1) – AI now runs server-side.
(() => { const s = jget(LS_SETTINGS, null); if (s && ('apiKey' in s || 'model' in s)) { delete s.apiKey; delete s.model; jset(LS_SETTINGS, s); } })();

/* ---------------- sync ---------------- */
let syncing = false, syncTimer = null, syncState = 'idle', lastSyncAt = null;
function scheduleSync(ms = 1200) { clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, ms); }
const entryData = (e) => ({ site: e.site || '', company: e.company || '', start: e.start || '', end: e.end || '', weather: e.weather || '', crew: e.crew || [], work: e.work || '', notes: e.notes || '', photos: e.photos || [] });
const rowToEntry = (r) => Object.assign({ date: r.date, site: '', company: '', start: '', end: '', weather: '', crew: [], work: '', notes: '', photos: [] }, r.data || {}, { date: r.date, updatedAt: r.updated_at });

async function syncNow() {
  if (!uid() || syncing) return;
  if (!navigator.onLine) { syncState = 'offline'; updateSyncBadge(); return; }
  syncing = true; syncState = 'syncing'; updateSyncBadge();
  const myId = uid();
  try {
    // 1) push local changes
    const p = pending.all(), all = store.entries();
    for (const [date, { op, t }] of Object.entries(p)) {
      if (op === 'del') {
        const { error } = await sb.from('logs').delete().eq('user_id', myId).eq('date', date);
        if (error) throw error;
      } else if (all[date]) {
        const e = all[date];
        const { error } = await sb.from('logs').upsert({ user_id: myId, date, data: entryData(e), updated_at: e.updatedAt || new Date().toISOString() }, { onConflict: 'user_id,date' });
        if (error) throw error;
      }
      if (uid() !== myId) return;
      pending.clear(date, t);
    }
    // 2) pull server state (server wins for anything not pending locally)
    const { data, error } = await sb.from('logs').select('date,data,updated_at').eq('user_id', myId);
    if (error) throw error;
    if (uid() !== myId) return;
    const still = pending.all(), local = store.entries(), next = {};
    data.forEach((r) => { next[r.date] = rowToEntry(r); });
    Object.keys(still).forEach((d) => { if (local[d]) next[d] = local[d]; else delete next[d]; });
    store.saveAll(next);
    // 3) company settings + my profile
    await Promise.all([pullCompany(), refreshProfile()]);
    syncState = pending.count() ? 'pending' : 'ok'; lastSyncAt = new Date();
    afterSyncRefresh();
  } catch (e) {
    console.warn('sync failed', e);
    syncState = /JWT|auth|401/i.test(e.message || '') ? 'auth' : 'error';
  } finally { syncing = false; updateSyncBadge(); if (pending.count() && syncState === 'ok') scheduleSync(); }
}

async function pullCompany() {
  const { data, error } = await sb.from('app_settings').select('company_name,logo,updated_at').eq('id', 1).maybeSingle();
  if (!error && data) company.set({ company_name: data.company_name || '', logo: data.logo || null, updated_at: data.updated_at });
}
async function refreshProfile() {
  const { data, error } = await sb.from('profiles').select('id,username,display_name,role,ai_enabled,disabled').eq('id', uid()).single();
  if (error || !data) return;
  if (data.disabled) { toast('המשתמש הושבת ע״י המנהל'); return logout(true); }
  me = data; jset(LS_PROFILE, me); applyRoleUI();
}
function afterSyncRefresh() {
  if (!dirty) {
    const s = store.get(current.date);
    if (s && JSON.stringify(entryData(s)) !== JSON.stringify(entryData(current))) { current = JSON.parse(JSON.stringify(s)); current.crew = current.crew || []; fillForm(current); }
    updateStatus();
  }
  if ($('#view-history').classList.contains('active') && histUser === 'me') { renderHistory(); renderExportUI(); }
  if ($('#view-settings').classList.contains('active')) renderSettings();
}
function updateSyncBadge() {
  const el = $('#syncStatus'); if (!el) return;
  const n = pending.count();
  const map = {
    syncing: ['🔄 מסנכרן…', ''], offline: [`📴 אופליין${n ? ` · ${n} ממתינים לסנכרון` : ''}`, 'warn'],
    error: [`⚠️ הסנכרון נכשל${n ? ` · ${n} ממתינים` : ''}`, 'warn'], auth: ['⚠️ יש להתחבר מחדש לסנכרון', 'warn'],
    pending: [`⏳ ${n} ממתינים לסנכרון`, 'warn'], ok: ['☁️ מסונכרן', 'ok'], idle: ['', ''],
  };
  let [txt, cls] = map[syncState] || map.idle;
  if (syncState === 'ok' && n) [txt, cls] = map.pending;
  el.textContent = txt; el.className = `sync ${cls}`;
}

/* ---------------- auth ---------------- */
async function resolveEmail(login) {
  const v = login.trim().toLowerCase();
  if (v.includes('@')) return v;
  const { data, error } = await sb.rpc('login_email', { p_username: v });
  if (error) throw error;
  return data || `${v}@${USER_DOMAIN}`;
}

async function doLogin(ev) {
  ev && ev.preventDefault();
  const u = $('#loginUser').value.trim(), p = $('#loginPass').value;
  const err = $('#loginErr'); err.textContent = '';
  if (!u || !p) { err.textContent = 'נא למלא שם משתמש וסיסמה'; return; }
  if (!navigator.onLine) { err.textContent = 'אין חיבור לאינטרנט – הכניסה הראשונה דורשת חיבור.'; return; }
  const btn = $('#loginBtn'); btn.disabled = true; btn.textContent = 'מתחבר…';
  try {
    const email = await resolveEmail(u);
    const { data, error } = await sb.auth.signInWithPassword({ email, password: p });
    if (error) throw error;
    $('#loginPass').value = '';
    await enterApp(data.user);
  } catch (e) {
    const m = String(e.message || e);
    err.textContent = /invalid login|invalid_credentials/i.test(m) ? 'שם משתמש או סיסמה שגויים'
      : /banned/i.test(m) ? 'המשתמש מושבת. פנה למנהל.'
      : /fetch|network/i.test(m) ? 'שגיאת רשת – בדוק את החיבור ונסה שוב.' : 'שגיאה בהתחברות: ' + m;
  } finally { btn.disabled = false; btn.textContent = 'כניסה'; }
}

function showLogin() {
  document.body.classList.add('auth-out'); document.body.classList.remove('auth-in', 'is-admin', 'booting');
  $('#loginScreen').hidden = false; $('#loginVer').textContent = APP_VERSION;
  setTimeout(() => $('#loginUser').focus(), 50);
}

async function enterApp(user, offline = false) {
  let prof = null;
  if (!offline) {
    const { data, error } = await sb.from('profiles').select('id,username,display_name,role,ai_enabled,disabled').eq('id', user.id).single();
    if (!error) prof = data;
    else { const c = jget(LS_PROFILE, null); if (c && c.id === user.id) prof = c; }
  } else { const c = jget(LS_PROFILE, null); if (c && c.id === user.id) prof = c; }
  if (!prof) { await sb.auth.signOut().catch(() => {}); showLogin(); $('#loginErr').textContent = 'לא נמצא פרופיל למשתמש. פנה למנהל.'; return; }
  if (prof.disabled) { await sb.auth.signOut().catch(() => {}); showLogin(); $('#loginErr').textContent = 'המשתמש מושבת. פנה למנהל.'; return; }
  me = prof; jset(LS_PROFILE, me);
  document.body.classList.remove('auth-out', 'booting'); document.body.classList.add('auth-in');
  $('#loginScreen').hidden = true;
  applyRoleUI();
  chat = loadChat(); histUser = 'me';
  dirty = false; current = blankEntry(todayISO());
  loadDate(todayISO()); showView('log');
  syncState = offline ? 'offline' : 'idle'; updateSyncBadge();
  if (!offline) { await pullCompany().catch(() => {}); await syncNow(); offerMigration(); }
}

function applyRoleUI() {
  document.body.classList.toggle('is-admin', isAdmin());
  $('#whoName').textContent = me ? (me.display_name || me.username) : '';
  $('#whoRole').textContent = isAdmin() ? 'מנהל' : '';
}

async function logout(force = false) {
  const n = pending.count();
  if (!force && n && !confirm(`יש ${n} ימים שעדיין לא סונכרנו לשרת. אם תתנתק עכשיו הם יישארו רק במכשיר. להתנתק בכל זאת?`)) return;
  if (dirty) saveCurrent(true);
  if (!pending.count()) { localStorage.removeItem(ukey('entries')); localStorage.removeItem(ukey('chat')); } // shared-device hygiene
  await sb.auth.signOut().catch(() => {});
  localStorage.removeItem(LS_AUTH);
  me = null; chat = []; showLogin();
}

async function boot() {
  const { data } = await sb.auth.getSession().catch(() => ({ data: {} }));
  if (data && data.session) return enterApp(data.session.user, !navigator.onLine);
  // Offline start with an expired access token: keep working from the local cache until we're online again.
  const raw = jget(LS_AUTH, null), cached = jget(LS_PROFILE, null);
  const u = raw && (raw.user || (raw.currentSession && raw.currentSession.user));
  if (!navigator.onLine && u && cached && cached.id === u.id) return enterApp(u, true);
  showLogin();
}

/* ---------------- one-time migration of v1.1 local data ---------------- */
function offerMigration() {
  const legacy = jget(LS_LEGACY_ENTRIES, null);
  const flag = `bmb.migrated.${uid()}`;
  if (!legacy || localStorage.getItem(flag)) return;
  const list = Object.values(legacy).filter((e) => e && validISO(e.date));
  if (!list.length) return;
  $('#migCount').textContent = list.length;
  $('#migSheet').hidden = false;
}
async function runMigration(upload) {
  $('#migSheet').hidden = true;
  localStorage.setItem(`bmb.migrated.${uid()}`, new Date().toISOString());
  if (!upload) return toast('אפשר להעלות מאוחר יותר דרך ייבוא JSON');
  const legacy = jget(LS_LEGACY_ENTRIES, {});
  const mine = store.entries();
  const list = Object.values(legacy).filter((e) => e && validISO(e.date)).map((e) => Object.assign(blankEntry(e.date), e, { crew: Array.isArray(e.crew) ? e.crew : [] }))
    .filter((e) => !mine[e.date] || (e.updatedAt || '') > (mine[e.date].updatedAt || ''));
  store.putMany(list);
  localStorage.setItem(LS_LEGACY_ENTRIES + '.migrated', localStorage.getItem(LS_LEGACY_ENTRIES)); localStorage.removeItem(LS_LEGACY_ENTRIES);
  // admin: also carry over the old per-device company name/logo if the server has none yet
  if (isAdmin()) {
    const oldS = jget(LS_SETTINGS, {}), oldLogo = jget(LS_LEGACY_LOGO, null), c = company.get();
    const patch = {};
    if (!c.company_name && oldS.company) patch.company_name = oldS.company;
    if (!c.logo && oldLogo) patch.logo = oldLogo;
    if (Object.keys(patch).length) await saveCompanyRemote(patch).catch(() => {});
  }
  await syncNow();
  loadDate(current.date);
  toast(`${list.length} ימים הועלו לחשבון ✓`);
}

/** Resize an image file to fit maxW×maxH, returns {dataUrl,w,h}. PNG keeps transparency; falls back to JPEG if large. */
function resizeImage(file, maxW = 480, maxH = 240) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const k = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
      const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, 0, 0, w, h);
      let dataUrl = c.toDataURL('image/png');
      if (dataUrl.length > 350000) {
        const c2 = document.createElement('canvas'); c2.width = w; c2.height = h;
        const x = c2.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.drawImage(c, 0, 0);
        dataUrl = c2.toDataURL('image/jpeg', 0.88);
      }
      resolve({ dataUrl, w, h });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('לא ניתן לקרוא את התמונה')); };
    img.src = url;
  });
}

/* ---------------- dates & hours ---------------- */
const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayISO = () => isoOf(new Date());
const parseISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const validISO = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(parseISO(s));
const fmtDate = (s) => { const d = parseISO(s); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; };
const weekday = (s) => parseISO(s).toLocaleDateString('he-IL', { weekday: 'long' });
const addDays = (s, n) => { const d = parseISO(s); d.setDate(d.getDate() + n); return isoOf(d); };
const validTime = (t) => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
function minutesBetween(start, end) {
  if (!validTime(start) || !validTime(end)) return null;
  const [sh, sm] = start.split(':').map(Number), [eh, em] = end.split(':').map(Number);
  let m = (eh * 60 + em) - (sh * 60 + sm);
  if (m < 0) m += 1440; // overnight shift
  return m;
}
const fmtDur = (m) => (m == null ? '—' : `${Math.floor(m / 60)}:${pad(m % 60)}`);
const hoursText = (m) => { const h = Math.round((m / 60) * 100) / 100; return h === 1 ? 'שעה אחת' : `${h} שעות`; };

/* ---------------- entry model ---------------- */
const blankEntry = (date) => ({ date, site: '', company: store.settings().company || '', start: '', end: '', weather: '', crew: [], work: '', notes: '', photos: [] });
const hasContent = (e) => !!(e.site || e.start || e.end || e.weather || e.work || e.notes || (e.crew || []).some((c) => c.name) || (e.photos || []).length);
let current = blankEntry(todayISO());
let dirty = false;

function crewLine(c) {
  const n = Number(c.count) || 0, name = (c.name || '').trim();
  switch (c.type) {
    case 'פועלים': return n ? `${n} פועלים${name ? ` – ${name}` : ''}` : `פועלים – ${name}`;
    case 'קבלן משנה': return `קבלן משנה: ${name}${n > 1 ? ` (${n} עובדים)` : ''}`;
    case 'ציוד': return `${name}${n > 1 ? ` × ${n}` : ''}`;
    default: return `${name}${n > 1 ? ` × ${n}` : ''}`;
  }
}
function bulletize(text) {
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return lines.join('');
  return lines.map((l) => (/^([•\-–*·]|\d+[.)])/.test(l) ? l.replace(/^[-–*·]\s*/, '• ') : `• ${l}`)).join('\n');
}

/** Clean Hebrew text for WhatsApp / copy. bold=true uses WhatsApp *bold*. */
function formatLog(e, bold = true) {
  const B = (s) => (bold ? `*${s}*` : s);
  const s = store.settings();
  const L = [B(`📋 יומן עבודה – יום ${weekday(e.date).replace(/^יום\s*/, '')}, ${fmtDate(e.date)}`)];
  if (e.site) L.push(`🏗️ אתר: ${e.site}`);
  if (e.company) L.push(`🏢 חברת בנייה: ${e.company}`);
  if (s.foreman) L.push(`👷 מנהל עבודה: ${s.foreman}`);
  if (e.start || e.end) {
    const m = minutesBetween(e.start, e.end);
    L.push(`⏰ שעות עבודה: ${e.start || '?'}–${e.end || '?'}${m != null ? ` (${hoursText(m)})` : ''}`);
  }
  if (e.weather) L.push(`🌤️ מזג אוויר: ${e.weather}`);
  const crew = e.crew.filter((c) => (c.name || '').trim());
  if (crew.length) { L.push('', B('נוכחים באתר:')); crew.forEach((c) => L.push(`• ${crewLine(c)}`)); }
  if (e.work && e.work.trim()) { L.push('', B('עבודות שבוצעו:'), bulletize(e.work)); }
  if (e.notes && e.notes.trim()) { L.push('', B('הערות:'), bulletize(e.notes)); }
  const ph = e.photos || [];
  if (ph.length) {
    const urls = ph.map((p) => photoUrls.peek(p.path)).filter(Boolean);
    L.push('', B(`📷 תמונות (${ph.length}):`));
    if (urls.length) { urls.forEach((u) => L.push(u)); L.push('(הקישורים תקפים ל-7 ימים)'); } else L.push('התמונות שמורות ביומן באפליקציה');
  }
  L.push('', '— BMB · Ben Menachem Bari');
  return L.join('\n');
}

/* ---------------- toast ---------------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

/* ---------------- log form ---------------- */
function readForm() {
  current.date = $('#f-date').value || current.date;
  current.site = $('#f-site').value.trim();
  current.company = $('#f-company').value.trim();
  current.start = $('#f-start').value;
  current.end = $('#f-end').value;
  current.weather = $('#f-weather').value.trim();
  current.work = $('#f-work').value;
  current.notes = $('#f-notes').value;
  return current;
}

function fillForm(e) {
  $('#f-date').value = e.date;
  $('#weekday').textContent = weekday(e.date);
  $('#f-site').value = e.site || '';
  $('#f-company').value = e.company || '';
  $('#f-start').value = e.start || '';
  $('#f-end').value = e.end || '';
  $('#f-weather').value = e.weather || '';
  $('#f-work').value = e.work || '';
  $('#f-notes').value = e.notes || '';
  renderCrew(); updateTotal(); syncChips(); fillSites(); autoGrow(); renderDayPhotos();
}

function renderCrew() {
  const box = $('#crewList');
  if (!current.crew.length) { box.innerHTML = '<div class="empty-crew">עדיין לא נוספו נוכחים</div>'; return; }
  box.innerHTML = current.crew.map((c, i) => `
    <div class="crew-row" data-i="${i}">
      <select class="c-type" data-f="type" aria-label="סוג">${CREW_TYPES.map((t) => `<option ${t === c.type ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <input class="c-count" data-f="count" type="number" inputmode="numeric" min="1" value="${esc(c.count)}" aria-label="כמות">
      <button type="button" class="c-del" aria-label="מחק שורה">✕</button>
      <input class="c-name" data-f="name" value="${esc(c.name)}" placeholder="${c.type === 'ציוד' ? 'לדוגמה: מחפר, מנוף, משאבת בטון' : c.type === 'פועלים' ? 'של מי? לדוגמה: צוות מאג׳ד' : 'שם'}" aria-label="שם">
    </div>`).join('');
}

function updateTotal() {
  const m = minutesBetween($('#f-start').value, $('#f-end').value);
  $('#totalHours').textContent = fmtDur(m);
}

function syncChips() {
  const w = $('#f-weather').value;
  $$('#weatherChips .chip').forEach((c) => c.classList.toggle('on', w.includes(c.textContent.replace(/^\S+\s/, ''))));
}

function fillSites() {
  const sites = [...new Set(Object.values(store.entries()).sort((a, b) => b.date.localeCompare(a.date)).map((e) => e.site).filter(Boolean))];
  $('#sitesList').innerHTML = sites.map((s) => `<option value="${esc(s)}">`).join('');
  const cos = [...new Set([store.settings().company, ...Object.values(store.entries()).map((e) => e.company)].filter(Boolean))];
  $('#companiesList').innerHTML = cos.map((s) => `<option value="${esc(s)}">`).join('');
}

function lastEntry() {
  const all = Object.values(store.entries()).sort((a, b) => b.date.localeCompare(a.date));
  return all[0] || null;
}

function updateStatus() {
  const b = $('#saveStatus'), saved = store.get(current.date);
  if (saved && !dirty) {
    const t = saved.updatedAt ? new Date(saved.updatedAt) : null;
    b.textContent = `✓ נשמר${t ? ` · ${pad(t.getHours())}:${pad(t.getMinutes())}` : ''}`; b.className = 'badge saved';
  } else if (saved && dirty) { b.textContent = 'שומר…'; b.className = 'badge'; }
  else { b.textContent = 'יום חדש – עדיין לא נשמר'; b.className = 'badge new'; }
  $('#todayBtn').style.visibility = current.date === todayISO() ? 'hidden' : 'visible';
}

function loadDate(date) {
  if (dirty) saveCurrent(true);
  const saved = store.get(date);
  if (saved) current = JSON.parse(JSON.stringify(saved));
  else {
    current = blankEntry(date);
    const last = lastEntry(); if (last && last.site) { current.site = last.site; if (last.company) current.company = last.company; } // convenience: same site as last time
  }
  current.crew = current.crew || [];
  dirty = false; fillForm(current); updateStatus();
}

function saveCurrent(silent = false) {
  readForm();
  if (!hasContent(current)) { if (!silent) toast('אין מה לשמור עדיין'); dirty = false; updateStatus(); return false; }
  current.updatedAt = new Date().toISOString();
  store.put(JSON.parse(JSON.stringify(current)));
  dirty = false; updateStatus(); fillSites();
  if (!silent) toast('היומן נשמר ✓');
  return true;
}

let saveTimer;
function markDirty() { dirty = true; updateStatus(); clearTimeout(saveTimer); saveTimer = setTimeout(() => saveCurrent(true), 700); }

function autoGrow() {
  $$('#logForm textarea').forEach((t) => { t.style.height = 'auto'; t.style.height = Math.max(t.scrollHeight + 4, 52) + 'px'; });
}

/* ---------------- share / copy / print ---------------- */
function currentText() { readForm(); return formatLog(current, true); }

function shareWhatsApp() {
  readForm(); if (!hasContent(current)) return toast('היומן ריק – אין מה לשלוח');
  saveCurrent(true);
  const url = 'https://wa.me/?text=' + encodeURIComponent(currentText());
  const w = window.open(url, '_blank');
  if (!w) location.href = url;
}

async function shareNative() {
  readForm(); if (!hasContent(current)) return toast('היומן ריק');
  saveCurrent(true);
  const text = currentText();
  if (navigator.share) {
    try { await navigator.share({ title: `יומן עבודה ${fmtDate(current.date)}`, text }); } catch (e) { if (e.name !== 'AbortError') copyText(text); }
  } else { copyText(text); }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('הטקסט הועתק ✓'); return true; }
  catch {
    const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
    let ok = false; try { ok = document.execCommand('copy'); } catch {}
    ta.remove(); toast(ok ? 'הטקסט הועתק ✓' : 'ההעתקה נכשלה'); return ok;
  }
}

function buildPrint(e) {
  const s = store.settings();
  const m = minutesBetween(e.start, e.end);
  const crew = e.crew.filter((c) => (c.name || '').trim());
  const row = (k, v) => (v ? `<tr><td>${k}</td><td>${esc(v)}</td></tr>` : '');
  $('#printArea').innerHTML = `
    <div class="p-head">
      <div class="p-brand"><svg viewBox="0 0 100 100"><use href="#bmb-logo"/></svg>
        <div><b>יומן עבודה</b><small dir="ltr">Ben Menachem Bari</small></div></div>
      ${companyLogo.get() ? `<img class="p-co" src="${companyLogo.get().dataUrl}" alt="">` : ''}
      <div class="p-date">${weekday(e.date)}<br>${fmtDate(e.date)}</div>
    </div>
    <table class="p-meta">
      ${row('אתר', e.site)}${row('חברת בנייה', e.company || s.company)}${row('מנהל עבודה', s.foreman)}
      ${e.start || e.end ? row('שעות עבודה', `${e.start || '?'}–${e.end || '?'}${m != null ? ` (${hoursText(m)})` : ''}`) : ''}
      ${row('מזג אוויר', e.weather)}
    </table>
    ${crew.length ? `<div class="p-sec"><h4>נוכחים באתר</h4><div>${crew.map((c) => '• ' + esc(crewLine(c))).join('\n')}</div></div>` : ''}
    ${e.work ? `<div class="p-sec"><h4>עבודות שבוצעו</h4><div>${esc(bulletize(e.work))}</div></div>` : ''}
    ${e.notes ? `<div class="p-sec"><h4>הערות</h4><div>${esc(bulletize(e.notes))}</div></div>` : ''}
    <div class="p-sign"><div>חתימת מנהל העבודה</div><div>חתימת המפקח</div></div>
    <div class="p-foot" dir="ltr">BMB · Ben Menachem Bari · ${fmtDate(e.date)}</div>`;
}
function printLog() { readForm(); saveCurrent(true); buildPrint(current); setTimeout(() => window.print(), 50); }

/* ---------------- history: see renderHistory below ---------------- */
function exportJSON() {
  const data = { app: 'bmb-work-log', version: APP_VERSION, exportedAt: new Date().toISOString(), entries: store.entries() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const name = `bmb-work-log-backup-${todayISO()}.json`;
  const file = typeof File === 'function' ? new File([blob], name, { type: 'application/json' }) : null;
  if (file && navigator.canShare && navigator.canShare({ files: [file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
    navigator.share({ files: [file], title: name }).catch(() => {});
    return;
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`נוצר גיבוי של ${Object.keys(data.entries).length} ימים`);
}

function importJSON(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const data = JSON.parse(r.result);
      const incoming = data.entries || data;
      const valid = Object.values(incoming).filter((e) => e && validISO(e.date));
      if (!valid.length) throw new Error('empty');
      const all = store.entries();
      const overlap = valid.filter((e) => all[e.date]).length;
      if (overlap && !confirm(`${overlap} ימים כבר קיימים במכשיר. לדרוס אותם עם הגיבוי?`)) return;
      store.putMany(valid.map((e) => Object.assign(blankEntry(e.date), e, { crew: Array.isArray(e.crew) ? e.crew : [] })));
      renderHistory(); loadDate(current.date);
      toast(`יובאו ${valid.length} ימים ✓`);
    } catch { alert('הקובץ לא תקין – יש לבחור קובץ גיבוי JSON של האפליקציה.'); }
  };
  r.readAsText(file);
}

/* ---------------- history (own logs, or – for admin – any user's logs, read-only) ---------------- */
let histUser = 'me';     // 'me' | '<user id>' | 'all'
let remoteList = [];     // entries fetched for admin views: {..entry, _owner, _key}
let usersCache = [];     // admin: list from admin-users edge function

function histSource() {
  if (histUser === 'me') return Object.values(store.entries()).map((e) => ({ ...e, _key: e.date }));
  return remoteList;
}
async function loadRemoteLogs() {
  if (!navigator.onLine) { remoteList = []; toast('צפייה ביומנים של משתמשים אחרים דורשת חיבור'); return; }
  let q = sb.from('logs').select('id,user_id,date,data,updated_at').order('date', { ascending: false }).limit(2000);
  if (histUser !== 'all') q = q.eq('user_id', histUser);
  const { data, error } = await q;
  if (error) { toast('שגיאה בטעינת יומנים'); remoteList = []; return; }
  const names = Object.fromEntries(usersCache.map((u) => [u.id, u.display_name || u.username]));
  remoteList = data.map((r) => ({ ...rowToEntry(r), _owner: names[r.user_id] || (r.user_id === uid() ? (me.display_name || me.username) : 'משתמש'), _uid: r.user_id, _key: r.id }));
}
async function renderHistUserPicker() {
  if (!isAdmin()) return;
  if (!usersCache.length && navigator.onLine) await loadUsers(true).catch(() => {});
  const sel = $('#histUser');
  sel.innerHTML = `<option value="me">היומנים שלי</option>` +
    usersCache.filter((u) => u.id !== uid()).map((u) => `<option value="${u.id}">${esc(u.display_name || u.username)} (${esc(u.username)})</option>`).join('') +
    `<option value="all">כל המשתמשים</option>`;
  sel.value = histUser;
}

function renderHistory() {
  const q = ($('#histSearch').value || '').trim();
  const ro = histUser !== 'me';
  const list = histSource().sort((a, b) => b.date.localeCompare(a.date) || String(a._owner || '').localeCompare(String(b._owner || '')))
    .filter((e) => !q || JSON.stringify(e).includes(q));
  const box = $('#histList');
  $('#backupCard').hidden = ro;
  if (!list.length) {
    box.innerHTML = `<div class="empty card"><svg viewBox="0 0 100 100"><use href="#bmb-logo"/></svg><div>${q ? 'לא נמצאו תוצאות' : ro ? 'אין יומנים למשתמש הזה' : 'עדיין אין ימים שמורים.<br>מלא את היומן של היום והוא יופיע כאן.'}</div></div>`;
    return;
  }
  const pend = pending.all();
  box.innerHTML = list.map((e) => {
    const m = minutesBetween(e.start, e.end);
    const crewN = (e.crew || []).filter((c) => c.type === 'פועלים' || c.type === 'קבלן משנה').reduce((a, c) => a + (Number(c.count) || 0), 0);
    const equip = (e.crew || []).filter((c) => c.type === 'ציוד').map((c) => c.name).join(', ');
    const sum = [(e.photos || []).length ? `📷 ${e.photos.length}` : '', crewN ? `${crewN} עובדים` : '', equip, (e.work || '').replace(/[•\n]+/g, ' ').trim()].filter(Boolean).join(' · ');
    return `<div class="hist-item ${e.date === todayISO() ? 'is-today' : ''}" data-key="${esc(e._key)}">
      <div class="hist-top"><span class="hist-date">${weekday(e.date)}, ${fmtDate(e.date)}</span><span class="hist-hours">${!ro && pend[e.date] ? '<span title="ממתין לסנכרון">⏳</span> ' : ''}${m != null ? '⏰ ' + fmtDur(m) : ''}</span></div>
      ${ro ? `<div class="hist-owner">👤 ${esc(e._owner)}</div>` : ''}
      <div class="hist-site">${esc(e.site || 'ללא שם אתר')}</div>
      <div class="hist-sum">${esc(sum || '—')}</div>
      <div class="hist-actions">
        ${ro ? `<button class="btn primary" data-act="view">👁️ הצג</button><button class="btn" data-act="wa">📤 שלח</button><button class="btn" data-act="xlsx">📊</button>`
        : `<button class="btn primary" data-act="open">✏️ פתח / ערוך</button><button class="btn" data-act="wa">📤 שלח</button><button class="btn danger-ghost" data-act="del">🗑️</button>`}
      </div></div>`;
  }).join('');
}
function findHist(key) { return histSource().find((e) => String(e._key) === String(key)); }
function logTextFor(e) {
  if (histUser === 'me') return formatLog(e, true);
  return formatLog(e, true).replace(/^(👷 מנהל עבודה: ).*$/m, `$1${e._owner}`);
}

/* ---------------- AI chat (server-side Gemini via edge function 'ai') ---------------- */
let chat = [];
function loadChat() { return uid() ? jget(ukey('chat'), []) : []; }
function persistChat() { if (uid()) jset(ukey('chat'), chat.slice(-40)); }
let busy = false;
const aiAllowed = () => !!me && (isAdmin() || me.ai_enabled);

function renderChat() {
  const box = $('#chatLog');
  let html = '';
  if (!aiAllowed()) {
    html += `<div class="msg sys">🔒 <b>עוזר ה-AI לא הופעל עבורך.</b><br>אפשר להמשיך למלא את היומן ידנית. להפעלה – פנה למנהל.</div>`;
  }
  if (!chat.length) {
    const name = me ? (me.display_name || me.username).split(' ')[0] : '';
    html += `<div class="msg ai">שלום ${esc(name)} 👋<br>ספר לי במילים שלך מה היה היום באתר – מי היה, איזה ציוד, מה עשיתם ומתי עבדתם.<br>אני אנסח יומן מקצועי, תראה תצוגה מקדימה, ורק אחרי שתאשר אמלא את הטופס.</div>`;
  }
  const lastPv = chat.map((m) => !!m.log).lastIndexOf(true);
  chat.forEach((m, i) => {
    if (m.role === 'user') html += `<div class="msg user">${(m.photos || []).length ? `<div class="msg-photos">${m.photos.map((p) => `<img src="${p.thumb}" alt="">`).join('')}</div>` : ''}${esc(m.content)}</div>`;
    else if (m.role === 'error') html += `<div class="msg err">⚠️ ${esc(m.content)}</div>`;
    else if (m.role === 'assistant') {
      if (m.reply) html += `<div class="msg ai">${esc(m.reply)}</div>`;
      if (m.log) {
        const st = m.approved ? 'done' : i !== lastPv ? 'old' : '';
        html += `<div class="preview ${st}" data-i="${i}">
          <header><span>${m.approved ? '✓ מולא ביומן' : '👀 תצוגה מקדימה'}</span><span>${fmtDate(m.log.date)}</span></header>
          <pre>${esc(formatLog(m.log, false))}</pre>
          ${m.approved || i !== lastPv ? (m.approved ? `<div class="pv-actions"><button class="btn" data-go="log" style="grid-column:1/-1">📋 פתח את היומן</button></div>` : '')
            : `${unattachedPhotos(i).length ? `<label class="pv-attach"><input type="checkbox" id="pvAttach" checked> 📎 צרף ${unattachedPhotos(i).length} תמונות ליומן של היום</label>` : ''}<div class="pv-actions"><button class="btn primary" data-act="approve">✓ אשר ומלא</button><button class="btn" data-act="fix">✎ תקן</button></div>`}
        </div>`;
      }
    }
  });
  if (busy) html += '<div class="typing"><i></i><i></i><i></i></div>';
  box.innerHTML = html;
  $('#chatInput').disabled = !aiAllowed(); $('#chatSend').disabled = busy || !aiAllowed();
}
function scrollChat() { window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); }

function parseJSONLoose(text) {
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('no json');
  return JSON.parse(t.slice(a, b + 1));
}

function normalizeLog(raw, base) {
  const L = Object.assign(JSON.parse(JSON.stringify(base)), {});
  if (!raw || typeof raw !== 'object') return L;
  if (validISO(raw.date)) L.date = raw.date;
  ['site', 'weather', 'work', 'notes'].forEach((k) => { if (typeof raw[k] === 'string') L[k] = raw[k].trim(); });
  ['start', 'end'].forEach((k) => {
    if (typeof raw[k] === 'string') {
      let v = raw[k].trim();
      if (/^\d{1,2}$/.test(v)) v = `${pad(v)}:00`;
      if (/^\d:\d\d$/.test(v)) v = '0' + v;
      L[k] = validTime(v) ? v : (v === '' ? '' : L[k]);
    }
  });
  if (Array.isArray(raw.crew)) {
    L.crew = raw.crew.filter((c) => c && (c.name || c.type)).map((c) => ({
      type: CREW_TYPES.includes(c.type) ? c.type : 'אחר',
      name: String(c.name || '').trim(),
      count: Math.max(1, parseInt(c.count, 10) || 1),
    }));
  }
  return L;
}

function buildApiMessages() {
  const ctx = readForm();
  const msgs = [];
  chat.forEach((m) => {
    if (m.role !== 'user' && m.role !== 'assistant') return;
    const content = m.role === 'assistant' ? (m.raw || JSON.stringify({ reply: m.reply, log: m.log })) : m.content;
    const prev = msgs[msgs.length - 1];
    if (prev && prev.role === m.role) prev.content += '\n' + content; else msgs.push({ role: m.role, content });
  });
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  const last = msgs[msgs.length - 1];
  const context = { today: todayISO(), today_weekday: weekday(todayISO()), form_date: ctx.date, current_form: { ...ctx, updatedAt: undefined, photos: undefined } };
  last.content = `[הקשר – לא מהמשתמש]\n${JSON.stringify(context)}\n\n[הודעת מנהל העבודה]\n${last.content}`;
  return msgs;
}

/** Calls the 'ai' edge function. The server holds the Gemini key and the system prompt. */
async function callAI(body) {
  if (!navigator.onLine) throw new Error('אין חיבור לאינטרנט – עוזר ה-AI עובד רק אונליין. אפשר להמשיך למלא את היומן ידנית.');
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error('ההתחברות פגה – התחבר מחדש.');
  let res;
  try {
    res = await fetch(`${SB_URL}/functions/v1/ai`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: SB_KEY, authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(body),
    });
  } catch { throw new Error('שגיאת רשת – בדוק את החיבור לאינטרנט ונסה שוב.'); }
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || `שגיאה מה-AI (${res.status})`);
  if (d.used != null) aiUsage = { used: d.used, limit: d.limit };
  return d;
}
let aiUsage = null;

async function sendChat() {
  const input = $('#chatInput');
  let text = input.value.trim();
  if (busy || (!text && !pendingPhotos.length)) return;
  if (!aiAllowed()) { renderChat(); return; }
  if (!text) text = 'צירפתי תמונה – עדכן את היומן לפי מה שרואים בה.';
  const photos = pendingPhotos.map((p) => ({ id: p.id, thumb: p.thumb }));
  const sendImgs = pendingPhotos.map((p) => ({ mime: 'image/jpeg', data: p.dataUrl.split(',')[1] }));
  chat.push({ role: 'user', content: text, ...(photos.length ? { photos } : {}) });
  pendingPhotos = []; renderPendingPhotos();
  input.value = ''; growComposer();
  busy = true; persistChat(); renderChat(); scrollChat(); $('#chatSend').disabled = true;
  try {
    const messages = buildApiMessages();
    if (sendImgs.length) messages[messages.length - 1].images = sendImgs;
    const { text: raw } = await callAI({ messages });
    let parsed;
    try { parsed = parseJSONLoose(raw); } catch { parsed = { reply: raw, log: null }; }
    const base = readForm();
    const log = parsed.log ? normalizeLog(parsed.log, { ...blankEntry(base.date), ...base }) : null;
    chat.push({ role: 'assistant', raw, reply: parsed.reply || (log ? 'הנה הניסוח המוצע:' : ''), log });
  } catch (e) {
    chat.push({ role: 'error', content: e.message || String(e) });
  } finally {
    busy = false; persistChat(); renderChat(); scrollChat();
  }
}

/** Photos sent in the chat since the last approved preview (up to preview i) that are not yet attached to a log. */
function unattachedPhotos(i) {
  let start = 0;
  for (let k = i - 1; k >= 0; k--) if (chat[k].approved) { start = k + 1; break; }
  return chat.slice(start, i).filter((m) => m.role === 'user' && m.photos).flatMap((m) => m.photos.filter((p) => !p.attached));
}

async function approvePreview(i) {
  const m = chat[i]; if (!m || !m.log) return;
  const attach = $('#pvAttach') ? $('#pvAttach').checked : false;
  const toAttach = attach ? unattachedPhotos(i) : [];
  const log = m.log;
  if (log.date && log.date !== current.date) loadDate(log.date);
  Object.assign(current, {
    site: log.site, start: log.start, end: log.end, weather: log.weather,
    crew: log.crew.map((c) => ({ ...c })), work: log.work, notes: log.notes,
  });
  fillForm(current);
  saveCurrent(true);
  m.approved = true; persistChat();
  showView('log');
  if (toAttach.length) {
    $('#busyText').textContent = 'מעלה תמונות…'; $('#busy').hidden = false;
    try {
      const n = await attachPhotosToDay(current.date, toAttach);
      toast(`היומן מולא ונשמר ✓ · ${n} תמונות צורפו`);
    } catch (e) { toast('היומן נשמר, אבל העלאת התמונות נכשלה: ' + (e.message || e)); }
    finally { $('#busy').hidden = true; $('#busyText').textContent = 'מכין קובץ…'; }
  } else toast('היומן מולא ונשמר ✓');
}

/* ---------------- photos: capture, resize, IndexedDB cache, Supabase Storage ---------------- */
const MAX_PHOTOS = 4;
const PHOTO_BUCKET = 'log-photos';
let pendingPhotos = []; // [{id, dataUrl, thumb}] – selected in the composer, not yet sent

const photoDB = {
  _db: null,
  open() {
    if (this._db) return this._db;
    this._db = new Promise((res, rej) => {
      const r = indexedDB.open('bmb-photos', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('img');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return this._db;
  },
  async tx(mode, fn) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('img', mode); const st = t.objectStore('img'); const out = fn(st); t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error); }); },
  put(k, v) { return this.tx('readwrite', (st) => { st.put(v, k); }); },
  get(k) { return this.tx('readonly', (st) => st.get(k)); },
  clear() { return this.tx('readwrite', (st) => { st.clear(); }); },
};

/** Resize to fit maxSide and encode JPEG. Returns dataUrl. */
function imageToJpeg(file, maxSide = 1600, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, w, h);
      let d = c.toDataURL('image/jpeg', quality);
      if (d.length > 1400000) d = c.toDataURL('image/jpeg', 0.62);
      resolve({ dataUrl: d, w, h });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('לא ניתן לקרוא את התמונה')); };
    img.src = url;
  });
}
function dataUrlToBlob(d) {
  const [head, b64] = d.split(','); const bin = atob(b64); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type: head.match(/data:([^;]+)/)[1] });
}
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

async function addPickedFiles(files) {
  const list = [...files].filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|heic|heif|webp)$/i.test(f.name));
  const room = MAX_PHOTOS - pendingPhotos.length;
  if (!room) return toast(`אפשר לצרף עד ${MAX_PHOTOS} תמונות להודעה`);
  if (list.length > room) toast(`נוספו ${room} תמונות בלבד (מקסימום ${MAX_PHOTOS})`);
  for (const f of list.slice(0, room)) {
    try {
      const full = await imageToJpeg(f, 1600, 0.8);
      const th = await imageToJpeg(dataUrlToBlob(full.dataUrl), 220, 0.7);
      const id = newId();
      await photoDB.put(id, full.dataUrl).catch(() => {});
      pendingPhotos.push({ id, dataUrl: full.dataUrl, thumb: th.dataUrl, w: full.w, h: full.h });
    } catch (e) { toast(e.message || 'שגיאה בתמונה'); }
  }
  renderPendingPhotos();
}
function renderPendingPhotos() {
  const box = $('#composerPhotos');
  box.hidden = !pendingPhotos.length;
  box.innerHTML = pendingPhotos.map((p, i) => `<div class="cp-thumb"><img src="${p.thumb}" alt=""><button type="button" data-i="${i}" aria-label="הסר תמונה">✕</button></div>`).join('')
    + (pendingPhotos.length ? `<small>${pendingPhotos.length}/${MAX_PHOTOS}</small>` : '');
  $('#camBtn').classList.toggle('has', pendingPhotos.length > 0);
}

/** Upload chat photos (from IndexedDB) to Storage under <uid>/<date>/ and add them to that day's log. */
async function attachPhotosToDay(date, photos) {
  if (!navigator.onLine) throw new Error('אין חיבור');
  const added = [];
  for (const p of photos) {
    const d = await photoDB.get(p.id).catch(() => null);
    if (!d) continue;
    const path = `${uid()}/${date}/${p.id}.jpg`;
    const { error } = await sb.storage.from(PHOTO_BUCKET).upload(path, dataUrlToBlob(d), { contentType: 'image/jpeg', upsert: true });
    if (error) throw error;
    added.push({ path, at: new Date().toISOString() });
    p.attached = true;
  }
  persistChat();
  if (!added.length) return 0;
  if (current.date !== date) loadDate(date);
  current.photos = [...(current.photos || []), ...added];
  dirty = true; saveCurrent(true); syncNow();
  await photoUrls.ensure(added.map((x) => x.path));
  renderDayPhotos();
  return added.length;
}

/** Signed URL cache (7 days) – also used to put links in the WhatsApp text. */
const photoUrls = {
  map: {},
  peek(path) { const v = this.map[path]; return v && v.exp > Date.now() + 3600e3 ? v.url : null; },
  async ensure(paths) {
    const need = paths.filter((p) => !this.peek(p));
    if (!need.length || !navigator.onLine) return;
    const { data, error } = await sb.storage.from(PHOTO_BUCKET).createSignedUrls(need, 7 * 86400);
    if (error || !data) return;
    data.forEach((d) => { if (d.signedUrl) this.map[d.path] = { url: d.signedUrl, exp: Date.now() + 7 * 86400e3 }; });
  },
};

function photoGrid(photos, removable) {
  return photos.map((p, i) => {
    const u = photoUrls.peek(p.path);
    return `<div class="dp-thumb" data-i="${i}">${u ? `<img src="${u}" alt="" loading="lazy" data-full="${esc(u)}">` : '<span>📷</span>'}${removable ? `<button type="button" data-del="${i}" aria-label="הסר תמונה">✕</button>` : ''}</div>`;
  }).join('');
}
async function renderDayPhotos() {
  const ph = current.photos || [], box = $('#dayPhotos');
  $('#dayPhotosField').hidden = !ph.length;
  if (!ph.length) { box.innerHTML = ''; return; }
  box.innerHTML = photoGrid(ph, true);
  const missing = ph.filter((p) => !photoUrls.peek(p.path));
  if (missing.length && navigator.onLine) {
    const date = current.date;
    await photoUrls.ensure(missing.map((p) => p.path));
    if (current.date === date) box.innerHTML = photoGrid(current.photos || [], true);
  }
}
async function removeDayPhoto(i) {
  const p = (current.photos || [])[i]; if (!p) return;
  if (!confirm('להסיר את התמונה מהיומן?')) return;
  current.photos = current.photos.filter((_, k) => k !== i);
  dirty = true; saveCurrent(true); renderDayPhotos();
  if (navigator.onLine && p.path.startsWith(uid() + '/')) sb.storage.from(PHOTO_BUCKET).remove([p.path]).catch(() => {});
}
function openPhoto(url) { $('#photoViewImg').src = url; $('#photoView').hidden = false; }

function growComposer() { const t = $('#chatInput'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, 160) + 'px'; }

/* ---------------- settings ---------------- */
function renderSettings() {
  if (!me) return;
  const s = store.settings(), c = company.get();
  $('#acctName').textContent = me.display_name || me.username;
  $('#acctUser').textContent = me.username;
  $('#acctRole').textContent = isAdmin() ? 'מנהל מערכת' : 'משתמש';
  $('#aiStatus').textContent = aiAllowed() ? `✓ עוזר AI פעיל${aiUsage ? ` · ${aiUsage.used}/${aiUsage.limit} בקשות היום` : ''}` : '✗ עוזר AI לא מופעל עבורך';
  $('#foreman').value = s.foreman || '';
  $('#company').value = c.company_name || '';
  $('#company').disabled = !isAdmin();
  renderLogoPreview();
  $('#ver').textContent = APP_VERSION;
}

function renderLogoPreview() {
  const l = companyLogo.get();
  $('#logoPreview').innerHTML = l ? `<img src="${l.dataUrl}" alt="לוגו החברה">` : '<span>אין לוגו</span>';
}

async function saveCompanyRemote(patch) {
  if (!isAdmin()) throw new Error('רק מנהל יכול לשנות את פרטי החברה');
  if (!navigator.onLine) throw new Error('שינוי פרטי החברה דורש חיבור לאינטרנט');
  const { data, error } = await sb.from('app_settings').update({ ...patch, updated_at: new Date().toISOString(), updated_by: uid() })
    .eq('id', 1).select('company_name,logo,updated_at').single();
  if (error) throw error;
  company.set({ company_name: data.company_name || '', logo: data.logo || null, updated_at: data.updated_at });
  return data;
}

async function changePassword() {
  const p1 = $('#newPass').value, p2 = $('#newPass2').value, st = $('#passStatus');
  if (p1.length < 8) { st.textContent = 'סיסמה חייבת להכיל לפחות 8 תווים'; return; }
  if (p1 !== p2) { st.textContent = 'הסיסמאות לא תואמות'; return; }
  if (!navigator.onLine) { st.textContent = 'נדרש חיבור לאינטרנט'; return; }
  st.textContent = 'מעדכן…';
  const { error } = await sb.auth.updateUser({ password: p1 });
  if (error) { st.textContent = '✗ ' + (/different from the old/i.test(error.message) ? 'הסיסמה החדשה זהה לישנה' : error.message); return; }
  $('#newPass').value = $('#newPass2').value = ''; st.textContent = '✓ הסיסמה עודכנה'; toast('הסיסמה עודכנה ✓');
}

/* ---------------- admin: users ---------------- */
async function adminCall(body) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error('ההתחברות פגה');
  const res = await fetch(`${SB_URL}/functions/v1/admin-users`, {
    method: 'POST', headers: { 'content-type': 'application/json', apikey: SB_KEY, authorization: `Bearer ${session.access_token}` }, body: JSON.stringify(body),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || `שגיאה (${res.status})`);
  return d;
}
async function loadUsers(silent = false) {
  if (!isAdmin()) return;
  if (!navigator.onLine) { if (!silent) $('#usersList').innerHTML = '<div class="card muted">ניהול משתמשים דורש חיבור לאינטרנט</div>'; return; }
  const d = await adminCall({ action: 'list' });
  usersCache = d.users || [];
  if (!silent) renderUsers();
}
const fmtWhen = (iso) => { if (!iso) return 'עוד לא נכנס'; const d = new Date(iso); return `${fmtDate(isoOf(d))} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function renderUsers() {
  $('#usersList').innerHTML = usersCache.map((u) => {
    const self = u.id === uid();
    return `<div class="card user-card ${u.disabled ? 'is-disabled' : ''}" data-id="${u.id}">
      <div class="u-head">
        <div class="u-avatar">${esc((u.display_name || u.username).trim().charAt(0).toUpperCase())}</div>
        <div class="u-names"><b>${esc(u.display_name || u.username)}</b><small dir="ltr">${esc(u.username)}${u.email && !u.email.endsWith('@' + USER_DOMAIN) ? ' · ' + esc(u.email) : ''}</small></div>
        <span class="tag ${u.role === 'admin' ? 'admin' : ''}">${u.role === 'admin' ? 'מנהל' : 'משתמש'}</span>
        ${u.disabled ? '<span class="tag off">מושבת</span>' : ''}
      </div>
      <div class="u-meta">📋 ${u.logs} ימים · ✨ ${u.ai_today} בקשות AI היום · 🕒 ${fmtWhen(u.last_sign_in_at)}</div>
      <div class="u-toggles">
        <label class="switch"><input type="checkbox" data-act="ai" ${u.ai_enabled || u.role === 'admin' ? 'checked' : ''} ${u.role === 'admin' ? 'disabled' : ''}><span></span> עוזר AI</label>
        ${self ? '' : `<label class="switch"><input type="checkbox" data-act="active" ${u.disabled ? '' : 'checked'}><span></span> פעיל</label>`}
      </div>
      <div class="u-actions">
        <button class="btn" data-act="pass">🔑 איפוס סיסמה</button>
        <button class="btn" data-act="logs">🗂️ יומנים</button>
        ${self ? '' : '<button class="btn danger-ghost" data-act="delete">🗑️</button>'}
      </div>
    </div>`;
  }).join('') || '<div class="card muted">אין משתמשים</div>';
}
function genPassword() {
  const a = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint32Array(12));
  return 'Bmb-' + [...r].map((x) => a[x % a.length]).join('');
}
function showSecret(title, user, pass) {
  $('#pwSheetTitle').textContent = title;
  $('#pwSheetUser').textContent = user; $('#pwSheetPass').textContent = pass;
  $('#pwSheet').hidden = false;
}
async function createUser(ev) {
  ev && ev.preventDefault();
  const username = $('#nuUser').value.trim().toLowerCase(), display_name = $('#nuName').value.trim();
  const password = $('#nuPass').value || genPassword();
  const st = $('#nuStatus'); st.textContent = '';
  if (!/^[a-z0-9._-]{2,32}$/.test(username)) { st.textContent = 'שם משתמש: 2–32 תווים באנגלית (אותיות קטנות, ספרות, . _ -)'; return; }
  if (password.length < 8) { st.textContent = 'סיסמה: לפחות 8 תווים'; return; }
  $('#nuBtn').disabled = true; st.textContent = 'יוצר משתמש…';
  try {
    await adminCall({ action: 'create', username, display_name, password, ai_enabled: $('#nuAi').checked, role: $('#nuRole').value });
    st.textContent = '✓ המשתמש נוצר'; $('#nuForm').reset(); $('#nuAi').checked = true;
    showSecret('המשתמש נוצר ✓', username, password);
    await loadUsers();
  } catch (e) { st.textContent = '✗ ' + e.message; } finally { $('#nuBtn').disabled = false; }
}

/* ---------------- excel export ---------------- */
let lastExport = null;
function rangeDates(kind) {
  const t = todayISO(), d = parseISO(t);
  if (kind === 'week') { const sun = addDays(t, -d.getDay()); return [sun, addDays(sun, 6)]; } // Israeli week: Sunday–Saturday
  if (kind === 'month') return [isoOf(new Date(d.getFullYear(), d.getMonth(), 1)), isoOf(new Date(d.getFullYear(), d.getMonth() + 1, 0))];
  if (kind === 'lastmonth') return [isoOf(new Date(d.getFullYear(), d.getMonth() - 1, 1)), isoOf(new Date(d.getFullYear(), d.getMonth(), 0))];
  if (kind === 'custom') return [$('#xFrom').value || '0000-01-01', $('#xTo').value || '9999-12-31'];
  return ['0000-01-01', '9999-12-31'];
}
function rangeEntries() {
  const kind = ($('#rangeChips .chip.on') || {}).dataset?.r || 'week';
  const [from, to] = rangeDates(kind); const site = $('#xSite').value;
  return histSource().filter((e) => e.date >= from && e.date <= to && (!site || e.site === site) && hasContent(e))
    .sort((a, b) => a.date.localeCompare(b.date));
}
function exportForemanLabel(list) {
  if (histUser === 'me') return undefined;
  return [...new Set(list.map((e) => e._owner))].join(', ');
}
function renderExportUI() {
  const sel = $('#xSite'), cur = sel.value;
  const sites = [...new Set(histSource().map((e) => e.site).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'he'));
  sel.innerHTML = '<option value="">כל האתרים</option>' + sites.map((x) => `<option ${x === cur ? 'selected' : ''}>${esc(x)}</option>`).join('');
  const kind = ($('#rangeChips .chip.on') || {}).dataset?.r;
  $('#customRange').hidden = kind !== 'custom';
  const list = rangeEntries();
  const [from, to] = rangeDates(kind);
  const label = kind === 'all' || kind === 'custom' && (!$('#xFrom').value || !$('#xTo').value) ? '' : ` (${fmtDate(from)} – ${fmtDate(to)})`;
  $('#xCount').textContent = list.length ? `נמצאו ${list.length} ימים${label}` : `אין ימים שמורים בטווח הזה${label}`;
  $('#xlsxRangeBtn').disabled = !list.length;
}
async function runExport(entries, opts) {
  if (!entries.length) return toast('אין נתונים לייצוא');
  $('#busy').hidden = false;
  try {
    lastExport = await buildWorkbook(entries, opts);
    $('#xSheetName').textContent = lastExport.filename;
    $('#xSheetInfo').textContent = `${lastExport.stats.days} ימים · ${lastExport.stats.contractors} קבלנים/פריטים · ${Math.ceil(lastExport.blob.size / 1024)} KB`;
    const file = new File([lastExport.blob], lastExport.filename, { type: lastExport.blob.type });
    $('#xSheetShare').hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
    $('#xSheet').hidden = false;
  } catch (e) { console.error(e); alert('שגיאה ביצירת קובץ האקסל: ' + (e.message || e)); }
  finally { $('#busy').hidden = true; }
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* ---------------- views ---------------- */
function showView(name) {
  if (name === 'users' && !isAdmin()) name = 'settings';
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'history') { renderHistory(); renderExportUI(); renderHistUserPicker(); photoUrls.ensure(histSource().flatMap((e) => (e.photos || []).map((p) => p.path)).slice(0, 200)).catch(() => {}); }
  if (name === 'chat') { renderChat(); setTimeout(scrollChat, 30); }
  if (name === 'settings') renderSettings();
  if (name === 'users') { renderUsers(); loadUsers().catch((e) => toast(e.message)); }
  if (name !== 'chat') window.scrollTo({ top: 0 });
}

/* ---------------- wire up ---------------- */
function init() {
  // login
  $('#loginForm').addEventListener('submit', doLogin);
  $('#loginEye').addEventListener('click', () => { const k = $('#loginPass'); k.type = k.type === 'password' ? 'text' : 'password'; });

  // tabs
  $$('.tabbar button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]'); if (go) showView(go.dataset.go);
  });

  // form
  const form = $('#logForm');
  form.addEventListener('input', (e) => {
    const row = e.target.closest('.crew-row');
    if (row) {
      const c = current.crew[+row.dataset.i], f = e.target.dataset.f;
      c[f] = f === 'count' ? (parseInt(e.target.value, 10) || '') : e.target.value;
      if (f === 'type') renderCrew();
    }
    if (e.target.id === 'f-start' || e.target.id === 'f-end') updateTotal();
    if (e.target.id === 'f-weather') syncChips();
    if (e.target.tagName === 'TEXTAREA') autoGrow();
    markDirty();
  });
  form.addEventListener('change', (e) => { if (e.target.closest('.crew-row')) markDirty(); });
  $('#crewList').addEventListener('click', (e) => {
    const del = e.target.closest('.c-del'); if (!del) return;
    current.crew.splice(+del.closest('.crew-row').dataset.i, 1); renderCrew(); markDirty();
  });
  $('#addCrew').addEventListener('click', () => {
    current.crew.push({ type: 'פועלים', name: '', count: 1 }); renderCrew();
    const rows = $$('.crew-row'); rows[rows.length - 1].querySelector('.c-name').focus();
  });
  $('#weatherChips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip'); if (!chip) return;
    const w = $('#f-weather'); const label = chip.textContent.trim();
    w.value = chip.classList.contains('on') ? '' : label; syncChips(); markDirty();
  });
  $('#f-date').addEventListener('change', (e) => { if (validISO(e.target.value)) loadDate(e.target.value); });
  $('#prevDay').addEventListener('click', () => loadDate(addDays(current.date, -1)));
  $('#nextDay').addEventListener('click', () => loadDate(addDays(current.date, 1)));
  $('#todayBtn').addEventListener('click', () => loadDate(todayISO()));

  $('#saveBtn').addEventListener('click', () => { saveCurrent(false); syncNow(); });
  $('#waBtn').addEventListener('click', shareWhatsApp);
  $('#shareBtn').addEventListener('click', shareNative);
  $('#copyBtn').addEventListener('click', () => { readForm(); if (!hasContent(current)) return toast('היומן ריק'); copyText(currentText()); });
  $('#printBtn').addEventListener('click', printLog);
  $('#clearDayBtn').addEventListener('click', () => {
    if (!confirm(`למחוק את היומן של ${fmtDate(current.date)}?`)) return;
    const ph = (current.photos || []).map((p) => p.path).filter((p) => p.startsWith(uid() + '/'));
    if (ph.length && navigator.onLine) sb.storage.from(PHOTO_BUCKET).remove(ph).catch(() => {});
    store.del(current.date); current = blankEntry(current.date); dirty = false; fillForm(current); updateStatus(); toast('היום נמחק');
  });
  window.addEventListener('beforeprint', () => { readForm(); buildPrint(current); });
  window.addEventListener('pagehide', () => { if (dirty) saveCurrent(true); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && dirty) saveCurrent(true);
    if (!document.hidden && uid()) syncNow();
  });

  // history
  $('#histSearch').addEventListener('input', renderHistory);
  $('#histUser').addEventListener('change', async (e) => {
    histUser = e.target.value;
    if (histUser !== 'me') { $('#histList').innerHTML = '<div class="card muted">טוען…</div>'; await loadRemoteLogs(); }
    renderHistory(); renderExportUI();
  });
  $('#histList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const en = findHist(btn.closest('.hist-item').dataset.key); if (!en) return;
    const act = btn.dataset.act;
    if (act === 'open') { loadDate(en.date); showView('log'); }
    if (act === 'wa') window.open('https://wa.me/?text=' + encodeURIComponent(logTextFor(en)), '_blank');
    if (act === 'view') {
      $('#viewSheetText').textContent = logTextFor(en).replace(/\*/g, ''); $('#viewSheetPhotos').innerHTML = ''; $('#viewSheet').hidden = false;
      if ((en.photos || []).length) photoUrls.ensure(en.photos.map((p) => p.path)).then(() => { $('#viewSheetPhotos').innerHTML = photoGrid(en.photos, false); $('#viewSheetText').textContent = logTextFor(en).replace(/\*/g, ''); });
    }
    if (act === 'xlsx') runExport([en], { foreman: en._owner });
    if (act === 'del' && confirm(`למחוק את היומן של ${fmtDate(en.date)}?`)) {
      store.del(en.date); if (en.date === current.date) { dirty = false; loadDate(en.date); } renderHistory(); renderExportUI(); toast('נמחק');
    }
  });
  $('#exportBtn').addEventListener('click', exportJSON);
  $('#importFile').addEventListener('change', (e) => { if (e.target.files[0]) importJSON(e.target.files[0]); e.target.value = ''; });

  // chat
  $('#chatSend').addEventListener('click', sendChat);
  $('#chatInput').addEventListener('input', growComposer);
  $('#chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !/iPhone|iPad|Android/i.test(navigator.userAgent)) { e.preventDefault(); sendChat(); } });
  $('#chatLog').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const i = +btn.closest('.preview').dataset.i;
    if (btn.dataset.act === 'approve') approvePreview(i);
    if (btn.dataset.act === 'fix') { const t = $('#chatInput'); t.placeholder = 'מה לתקן? למשל: היו 4 פועלים ולא 3, וסיימנו ב-17:00'; t.focus(); }
  });
  $('#newChat').addEventListener('click', () => { if (!chat.length || confirm('להתחיל שיחה חדשה?')) { chat = []; pendingPhotos = []; renderPendingPhotos(); photoDB.clear().catch(() => {}); persistChat(); renderChat(); } });
  // camera / gallery
  $('#camBtn').addEventListener('click', () => { if (!aiAllowed()) return; $('#camSheet').hidden = false; });
  $('#camTake').addEventListener('click', () => { $('#camSheet').hidden = true; $('#camInput').click(); });
  $('#camGallery').addEventListener('click', () => { $('#camSheet').hidden = true; $('#galleryInput').click(); });
  $('#camCancel').addEventListener('click', () => { $('#camSheet').hidden = true; });
  ['#camInput', '#galleryInput'].forEach((id) => $(id).addEventListener('change', async (e) => { const f = [...e.target.files]; e.target.value = ''; if (f.length) await addPickedFiles(f); }));
  $('#composerPhotos').addEventListener('click', (e) => { const b = e.target.closest('button[data-i]'); if (!b) return; pendingPhotos.splice(+b.dataset.i, 1); renderPendingPhotos(); });
  $('#dayPhotos').addEventListener('click', (e) => {
    const d = e.target.closest('[data-del]'); if (d) return removeDayPhoto(+d.dataset.del);
    const img = e.target.closest('img[data-full]'); if (img) openPhoto(img.dataset.full);
  });
  $('#viewSheetPhotos').addEventListener('click', (e) => { const img = e.target.closest('img[data-full]'); if (img) openPhoto(img.dataset.full); });
  $('#photoView').addEventListener('click', () => { $('#photoView').hidden = true; $('#photoViewImg').src = ''; });

  // settings – account
  $('#passForm').addEventListener('submit', (e) => { e.preventDefault(); changePassword(); });
  $('#logoutBtn').addEventListener('click', () => logout(false));
  $('#testAi').addEventListener('click', async () => {
    $('#aiStatus').textContent = 'בודק…';
    try { const r = await callAI({ ping: true }); aiUsage = { used: r.used, limit: r.limit }; $('#aiStatus').textContent = `✓ עוזר AI מחובר · ${r.used}/${r.limit} בקשות היום`; }
    catch (e) { $('#aiStatus').textContent = '✗ ' + e.message; }
  });
  $('#syncBtn').addEventListener('click', () => syncNow());
  $('#saveProfile').addEventListener('click', () => { store.saveSettings({ foreman: $('#foreman').value.trim() }); toast('הפרטים נשמרו ✓'); });

  // company settings (admin only – also enforced by RLS on app_settings)
  $('#logoFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try { const r = await resizeImage(f); await saveCompanyRemote({ logo: r }); renderLogoPreview(); toast('הלוגו נשמר ✓'); }
    catch (err) { alert(err.message || 'שגיאה בטעינת התמונה'); }
  });
  $('#logoClear').addEventListener('click', async () => {
    if (!companyLogo.get() || !confirm('להסיר את לוגו החברה?')) return;
    try { await saveCompanyRemote({ logo: null }); renderLogoPreview(); toast('הלוגו הוסר'); } catch (err) { alert(err.message); }
  });
  $('#saveCompany').addEventListener('click', async () => {
    const name = $('#company').value.trim();
    try {
      await saveCompanyRemote({ company_name: name });
      if (name && !$('#f-company').value) { $('#f-company').value = name; markDirty(); }
      fillSites(); toast('פרטי החברה נשמרו ✓');
    } catch (err) { alert(err.message); }
  });

  // admin – users
  $('#nuForm').addEventListener('submit', createUser);
  $('#nuGen').addEventListener('click', () => { $('#nuPass').type = 'text'; $('#nuPass').value = genPassword(); });
  $('#usersRefresh').addEventListener('click', () => loadUsers().catch((e) => toast(e.message)));
  $('#usersList').addEventListener('change', async (e) => {
    const inp = e.target.closest('input[data-act]'); if (!inp) return;
    const id = inp.closest('.user-card').dataset.id;
    const body = inp.dataset.act === 'ai' ? { action: 'update', id, ai_enabled: inp.checked } : { action: 'update', id, disabled: !inp.checked };
    try { await adminCall(body); toast('עודכן ✓'); await loadUsers(); } catch (err) { inp.checked = !inp.checked; toast('✗ ' + err.message); }
  });
  $('#usersList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    const id = btn.closest('.user-card').dataset.id, u = usersCache.find((x) => x.id === id); if (!u) return;
    if (btn.dataset.act === 'pass') {
      const p = prompt(`סיסמה חדשה עבור ${u.username} (לפחות 8 תווים).\nהשאר ריק ליצירת סיסמה אקראית:`, '');
      if (p === null) return;
      const password = p.trim() || genPassword();
      try { await adminCall({ action: 'reset_password', id, password }); showSecret('הסיסמה אופסה ✓', u.username, password); } catch (err) { toast('✗ ' + err.message); }
    }
    if (btn.dataset.act === 'logs') { histUser = id === uid() ? 'me' : id; showView('history'); if (histUser !== 'me') { await loadRemoteLogs(); renderHistory(); renderExportUI(); } $('#histUser').value = histUser; }
    if (btn.dataset.act === 'delete' && confirm(`למחוק לצמיתות את המשתמש ${u.username} וכל היומנים שלו?\n(אפשר במקום זה להשבית אותו)`)) {
      try { await adminCall({ action: 'delete', id }); toast('המשתמש נמחק'); await loadUsers(); } catch (err) { toast('✗ ' + err.message); }
    }
  });
  $('#pwCopy').addEventListener('click', () => copyText(`שם משתמש: ${$('#pwSheetUser').textContent}\nסיסמה: ${$('#pwSheetPass').textContent}\nכניסה: ${location.origin}${location.pathname}`));
  $('#pwClose').addEventListener('click', () => { $('#pwSheet').hidden = true; $('#pwSheetPass').textContent = ''; });
  $('#viewClose').addEventListener('click', () => { $('#viewSheet').hidden = true; });

  // migration
  $('#migYes').addEventListener('click', () => runMigration(true));
  $('#migNo').addEventListener('click', () => runMigration(false));

  // excel export
  $('#xlsxDayBtn').addEventListener('click', () => {
    readForm(); if (!hasContent(current)) return toast('היומן של היום ריק');
    saveCurrent(true); runExport([JSON.parse(JSON.stringify(current))]);
  });
  $('#rangeChips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    $$('#rangeChips .chip').forEach((x) => x.classList.toggle('on', x === c));
    if (c.dataset.r === 'custom' && !$('#xFrom').value) { const [a, b] = rangeDates('month'); $('#xFrom').value = a; $('#xTo').value = b; }
    renderExportUI();
  });
  ['#xFrom', '#xTo', '#xSite'].forEach((id) => $(id).addEventListener('change', renderExportUI));
  $('#xlsxRangeBtn').addEventListener('click', () => { const l = rangeEntries(); runExport(l, { siteLabel: $('#xSite').value || undefined, foreman: exportForemanLabel(l) }); });
  $('#xSheetDownload').addEventListener('click', () => { if (lastExport) downloadBlob(lastExport.blob, lastExport.filename); });
  $('#xSheetShare').addEventListener('click', async () => {
    if (!lastExport) return;
    const file = new File([lastExport.blob], lastExport.filename, { type: lastExport.blob.type });
    try { await navigator.share({ files: [file], title: lastExport.filename }); }
    catch (e) { if (e.name !== 'AbortError') downloadBlob(lastExport.blob, lastExport.filename); }
  });
  $('#xSheetClose').addEventListener('click', () => { $('#xSheet').hidden = true; });
  $$('.sheet').forEach((s) => s.addEventListener('click', (e) => { if (e.target === s && s.id !== 'migSheet') s.hidden = true; }));

  // network status
  const net = () => {
    $('#netStatus').classList.toggle('off', !navigator.onLine); $('#netStatus').title = navigator.onLine ? 'מחובר' : 'אופליין';
    if (navigator.onLine && uid()) syncNow(); else if (uid()) { syncState = 'offline'; updateSyncBadge(); }
  };
  window.addEventListener('online', net); window.addEventListener('offline', net); net();
  setInterval(() => { if (uid() && navigator.onLine && !document.hidden) syncNow(); }, 60000);

  sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT' && me) { me = null; showLogin(); } });
  boot();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return; // first install: nothing to refresh
      reloaded = true; if (dirty) saveCurrent(true); location.reload();
    });
    navigator.serviceWorker.register('sw.js').then((r) => r.update()).catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
