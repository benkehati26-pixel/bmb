/* BMB · יומן עבודה – Ben Menachem Bari
 * Static, offline-first PWA. All data lives in this device's localStorage.
 * SECURITY: no API key is embedded anywhere. The user enters their own Anthropic key in Settings;
 * it is stored only in localStorage on their device and sent only to api.anthropic.com.
 */
'use strict';

const APP_VERSION = '1.1.0';
const LS_LOGO = 'bmb.companyLogo.v1';
const LS_ENTRIES = 'bmb.entries.v1';
const LS_SETTINGS = 'bmb.settings.v1';
const LS_CHAT = 'bmb.chat.v1';
const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const FALLBACK_MODELS = ['claude-sonnet-5-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5-20250929'];
const CREW_TYPES = ['פועלים', 'קבלן משנה', 'ציוד', 'אחר'];

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- storage ---------------- */
const store = {
  entries() { try { return JSON.parse(localStorage.getItem(LS_ENTRIES)) || {}; } catch { return {}; } },
  saveAll(obj) { localStorage.setItem(LS_ENTRIES, JSON.stringify(obj)); },
  get(date) { return this.entries()[date] || null; },
  put(entry) { const all = this.entries(); all[entry.date] = entry; this.saveAll(all); },
  del(date) { const all = this.entries(); delete all[date]; this.saveAll(all); },
  settings() {
    const def = { apiKey: '', model: DEFAULT_MODEL, foreman: 'בן מנחם בארי', company: '' };
    try { return Object.assign(def, JSON.parse(localStorage.getItem(LS_SETTINGS)) || {}); } catch { return def; }
  },
  saveSettings(patch) { localStorage.setItem(LS_SETTINGS, JSON.stringify(Object.assign(this.settings(), patch))); },
};

const companyLogo = {
  get() { try { return JSON.parse(localStorage.getItem(LS_LOGO)) || null; } catch { return null; } },
  set(v) { localStorage.setItem(LS_LOGO, JSON.stringify(v)); },
  clear() { localStorage.removeItem(LS_LOGO); },
};

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
const blankEntry = (date) => ({ date, site: '', company: store.settings().company || '', start: '', end: '', weather: '', crew: [], work: '', notes: '' });
const hasContent = (e) => !!(e.site || e.start || e.end || e.weather || e.work || e.notes || e.crew.some((c) => c.name));
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
  L.push('', '— BMB · Ben Menachem Bari');
  return L.join('\n');
}

/* ---------------- toast ---------------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

/* ---------------- views ---------------- */
function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'history') { renderHistory(); renderExportUI(); }
  if (name === 'chat') { renderChat(); setTimeout(scrollChat, 30); }
  if (name === 'settings') renderSettings();
  if (name !== 'chat') window.scrollTo({ top: 0 });
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
  renderCrew(); updateTotal(); syncChips(); fillSites(); autoGrow();
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

/* ---------------- history ---------------- */
function renderHistory() {
  const q = ($('#histSearch').value || '').trim();
  const list = Object.values(store.entries()).sort((a, b) => b.date.localeCompare(a.date))
    .filter((e) => !q || JSON.stringify(e).includes(q));
  const box = $('#histList');
  if (!list.length) {
    box.innerHTML = `<div class="empty card"><svg viewBox="0 0 100 100"><use href="#bmb-logo"/></svg><div>${q ? 'לא נמצאו תוצאות' : 'עדיין אין ימים שמורים.<br>מלא את היומן של היום והוא יופיע כאן.'}</div></div>`;
    return;
  }
  box.innerHTML = list.map((e) => {
    const m = minutesBetween(e.start, e.end);
    const crewN = (e.crew || []).filter((c) => c.type === 'פועלים' || c.type === 'קבלן משנה').reduce((a, c) => a + (Number(c.count) || 0), 0);
    const equip = (e.crew || []).filter((c) => c.type === 'ציוד').map((c) => c.name).join(', ');
    const sum = [crewN ? `${crewN} עובדים` : '', equip, (e.work || '').replace(/[•\n]+/g, ' ').trim()].filter(Boolean).join(' · ');
    return `<div class="hist-item ${e.date === todayISO() ? 'is-today' : ''}" data-date="${e.date}">
      <div class="hist-top"><span class="hist-date">${weekday(e.date)}, ${fmtDate(e.date)}</span><span class="hist-hours">${m != null ? '⏰ ' + fmtDur(m) : ''}</span></div>
      <div class="hist-site">${esc(e.site || 'ללא שם אתר')}</div>
      <div class="hist-sum">${esc(sum || '—')}</div>
      <div class="hist-actions">
        <button class="btn primary" data-act="open">✏️ פתח / ערוך</button>
        <button class="btn" data-act="wa">📤 שלח</button>
        <button class="btn danger-ghost" data-act="del">🗑️</button>
      </div></div>`;
  }).join('');
}

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
      valid.forEach((e) => { all[e.date] = Object.assign(blankEntry(e.date), e, { crew: Array.isArray(e.crew) ? e.crew : [] }); });
      store.saveAll(all); renderHistory(); loadDate(current.date);
      toast(`יובאו ${valid.length} ימים ✓`);
    } catch { alert('הקובץ לא תקין – יש לבחור קובץ גיבוי JSON של האפליקציה.'); }
  };
  r.readAsText(file);
}

/* ---------------- AI chat ---------------- */
const SYSTEM_PROMPT = `You are the assistant of an Israeli construction site foreman (מנהל עבודה), Ben Menachem Bari.
He writes short, informal Hebrew notes about his work day (sometimes with typos or slang). Your job: turn them into a professional, clear daily site work log (יומן עבודה) in Hebrew, as written on Israeli construction sites.

Respond with ONLY one JSON object – no markdown, no code fences, no text before or after – in exactly this shape:
{
  "reply": "short friendly Hebrew message to the foreman (1-2 sentences): what you understood; ask a short question only if something important is unclear",
  "log": {
    "date": "YYYY-MM-DD",
    "site": "string",
    "start": "HH:MM or empty string",
    "end": "HH:MM or empty string",
    "weather": "string or empty",
    "crew": [{"type": "פועלים" | "קבלן משנה" | "ציוד" | "אחר", "name": "string", "count": 1}],
    "work": "string",
    "notes": "string"
  }
}

Rules:
- "log" is ALWAYS the COMPLETE updated log: start from the current form contents given in the context, merge everything the foreman said in this conversation, and apply his corrections. Keep existing values he did not change. Never drop existing crew rows or work lines unless he asks.
- "work": professional construction Hebrew, one item per line, each line starting with "• " and ending with a period (e.g. "• יציקת כלונסאות מס' 12–15."). Use correct professional terms (חפירה, מילוי והידוק, כלונסאות, ראשי כלונסאות, זיון, טפסנות, יציקה, קורות יסוד, רפסודה, תקרה, בלוקים, טיח, איטום וכו'). Do not invent work that was not mentioned.
- "crew": a team of workers → type "פועלים", name = whose team (e.g. "צוות מאג'ד"), count = number of workers. A subcontractor → "קבלן משנה" (name = trade/company, count = number of workers if known, else 1). Machines/equipment (מחפר, באגר, מיני מחפרון, בובקט, מנוף, משאבת בטון, מקדחה, משאית) → "ציוד", count = number of units.
- Times in 24h: "7 עד 16" → start "07:00", end "16:00"; "עד 4" in a work-day context means 16:00.
- "date": the date given in the context unless he says otherwise ("אתמול" → previous day).
- "notes": safety issues, delays, deliveries/supplies, instructions, visits (מפקח, יועץ, קונסטרוקטור), problems. Professional phrasing.
- Never invent facts, names, numbers or times. Unknown fields stay as in the current form (or "").
- Hebrew only in values (except proper names/numbers).`;

let chat = loadChat();
function loadChat() { try { return JSON.parse(localStorage.getItem(LS_CHAT)) || []; } catch { return []; } }
function persistChat() { localStorage.setItem(LS_CHAT, JSON.stringify(chat.slice(-40))); }
let busy = false;

function renderChat() {
  const box = $('#chatLog');
  const key = store.settings().apiKey;
  let html = '';
  if (!key) {
    html += `<div class="msg sys">🔑 <b>לא הוגדר מפתח API.</b><br>כדי להשתמש בעוזר ה-AI יש להזין מפתח Anthropic במסך ההגדרות (פעם אחת, נשמר רק במכשיר הזה).<button class="btn amber" data-go="settings">⚙️ למסך ההגדרות</button></div>`;
  }
  if (!chat.length) {
    html += `<div class="msg ai">שלום בן 👋<br>ספר לי במילים שלך מה היה היום באתר – מי היה, איזה ציוד, מה עשיתם ומתי עבדתם.<br>אני אנסח יומן מקצועי, תראה תצוגה מקדימה, ורק אחרי שתאשר אמלא את הטופס.</div>`;
  }
  const lastPv = chat.map((m) => !!m.log).lastIndexOf(true);
  chat.forEach((m, i) => {
    if (m.role === 'user') html += `<div class="msg user">${esc(m.content)}</div>`;
    else if (m.role === 'error') html += `<div class="msg err">⚠️ ${esc(m.content)}</div>`;
    else if (m.role === 'assistant') {
      if (m.reply) html += `<div class="msg ai">${esc(m.reply)}</div>`;
      if (m.log) {
        const st = m.approved ? 'done' : i !== lastPv ? 'old' : '';
        html += `<div class="preview ${st}" data-i="${i}">
          <header><span>${m.approved ? '✓ מולא ביומן' : '👀 תצוגה מקדימה'}</span><span>${fmtDate(m.log.date)}</span></header>
          <pre>${esc(formatLog(m.log, false))}</pre>
          ${m.approved || i !== lastPv ? (m.approved ? `<div class="pv-actions"><button class="btn" data-go="log" style="grid-column:1/-1">📋 פתח את היומן</button></div>` : '')
            : `<div class="pv-actions"><button class="btn primary" data-act="approve">✓ אשר ומלא</button><button class="btn" data-act="fix">✎ תקן</button></div>`}
        </div>`;
      }
    }
  });
  if (busy) html += '<div class="typing"><i></i><i></i><i></i></div>';
  box.innerHTML = html;
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
  const context = { today: todayISO(), today_weekday: weekday(todayISO()), form_date: ctx.date, current_form: { ...ctx, updatedAt: undefined } };
  last.content = `[הקשר – לא מהמשתמש]\n${JSON.stringify(context)}\n\n[הודעת מנהל העבודה]\n${last.content}`;
  return msgs;
}

async function callClaude(messages, opts = {}) {
  const s = store.settings();
  if (!s.apiKey) throw new Error('לא הוגדר מפתח API. היכנס להגדרות והזן מפתח Anthropic.');
  if (!navigator.onLine) throw new Error('אין חיבור לאינטרנט – עוזר ה-AI עובד רק אונליין. אפשר להמשיך למלא את היומן ידנית.');
  const models = [s.model || DEFAULT_MODEL, ...FALLBACK_MODELS.filter((m) => m !== s.model)];
  let lastErr;
  for (const model of models) {
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': s.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({ model, max_tokens: opts.maxTokens || 2000, system: opts.system ?? SYSTEM_PROMPT, messages }),
      });
    } catch { throw new Error('שגיאת רשת – בדוק את החיבור לאינטרנט ונסה שוב.'); }
    if (res.ok) {
      const d = await res.json();
      return { text: (d.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''), model };
    }
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || res.statusText;
    if (res.status === 404 || (res.status === 400 && /model/i.test(msg))) { lastErr = new Error(`המודל ${model} לא זמין`); continue; }
    if (res.status === 401) throw new Error('מפתח ה-API לא תקין (401). בדוק אותו במסך ההגדרות.');
    if (res.status === 403) throw new Error('למפתח אין הרשאה (403): ' + msg);
    if (res.status === 429) throw new Error('יותר מדי בקשות או חריגה ממכסה (429). נסה שוב בעוד דקה.');
    if (res.status === 529 || res.status >= 500) throw new Error(`שירות ה-AI עמוס כרגע (${res.status}). נסה שוב.`);
    throw new Error(`שגיאה מה-AI (${res.status}): ${msg}`);
  }
  throw lastErr || new Error('לא נמצא מודל זמין');
}

async function sendChat() {
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text || busy) return;
  if (!store.settings().apiKey) { renderChat(); toast('צריך להגדיר מפתח API קודם'); return; }
  chat.push({ role: 'user', content: text }); input.value = ''; growComposer();
  busy = true; persistChat(); renderChat(); scrollChat(); $('#chatSend').disabled = true;
  try {
    const { text: raw } = await callClaude(buildApiMessages());
    let parsed;
    try { parsed = parseJSONLoose(raw); } catch { parsed = { reply: raw, log: null }; }
    const base = readForm();
    const log = parsed.log ? normalizeLog(parsed.log, { ...blankEntry(base.date), ...base }) : null;
    chat.push({ role: 'assistant', raw, reply: parsed.reply || (log ? 'הנה הניסוח המוצע:' : ''), log });
  } catch (e) {
    chat.push({ role: 'error', content: e.message || String(e) });
  } finally {
    busy = false; $('#chatSend').disabled = false; persistChat(); renderChat(); scrollChat();
  }
}

function approvePreview(i) {
  const m = chat[i]; if (!m || !m.log) return;
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
  toast('היומן מולא ונשמר ✓');
}

function growComposer() { const t = $('#chatInput'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, 160) + 'px'; }

/* ---------------- settings ---------------- */
function renderSettings() {
  const s = store.settings();
  $('#apiKey').value = s.apiKey || '';
  $('#model').value = s.model || DEFAULT_MODEL;
  $('#foreman').value = s.foreman || '';
  $('#company').value = s.company || '';
  renderLogoPreview();
  $('#keyStatus').textContent = s.apiKey ? `✓ מפתח שמור במכשיר (…${s.apiKey.slice(-4)})` : 'לא הוגדר מפתח';
  $('#ver').textContent = APP_VERSION;
}

function renderLogoPreview() {
  const l = companyLogo.get();
  $('#logoPreview').innerHTML = l ? `<img src="${l.dataUrl}" alt="לוגו החברה">` : '<span>אין לוגו</span>';
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
  return Object.values(store.entries()).filter((e) => e.date >= from && e.date <= to && (!site || e.site === site) && hasContent(e))
    .sort((a, b) => a.date.localeCompare(b.date));
}
function renderExportUI() {
  const sel = $('#xSite'), cur = sel.value;
  const sites = [...new Set(Object.values(store.entries()).map((e) => e.site).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'he'));
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

/* ---------------- wire up ---------------- */
function init() {
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

  $('#saveBtn').addEventListener('click', () => saveCurrent(false));
  $('#waBtn').addEventListener('click', shareWhatsApp);
  $('#shareBtn').addEventListener('click', shareNative);
  $('#copyBtn').addEventListener('click', () => { readForm(); if (!hasContent(current)) return toast('היומן ריק'); copyText(currentText()); });
  $('#printBtn').addEventListener('click', printLog);
  $('#clearDayBtn').addEventListener('click', () => {
    if (!confirm(`למחוק את היומן של ${fmtDate(current.date)}?`)) return;
    store.del(current.date); current = blankEntry(current.date); dirty = false; fillForm(current); updateStatus(); toast('היום נמחק');
  });
  window.addEventListener('beforeprint', () => { readForm(); buildPrint(current); });
  window.addEventListener('pagehide', () => { if (dirty) saveCurrent(true); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && dirty) saveCurrent(true); });

  // history
  $('#histSearch').addEventListener('input', renderHistory);
  $('#histList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const date = btn.closest('.hist-item').dataset.date;
    if (btn.dataset.act === 'open') { loadDate(date); showView('log'); }
    if (btn.dataset.act === 'wa') { const en = store.get(date); window.open('https://wa.me/?text=' + encodeURIComponent(formatLog(en, true)), '_blank'); }
    if (btn.dataset.act === 'del' && confirm(`למחוק את היומן של ${fmtDate(date)}?`)) {
      store.del(date); if (date === current.date) loadDate(date); renderHistory(); toast('נמחק');
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
  $('#newChat').addEventListener('click', () => { if (!chat.length || confirm('להתחיל שיחה חדשה?')) { chat = []; persistChat(); renderChat(); } });

  // settings
  $('#toggleKey').addEventListener('click', () => { const k = $('#apiKey'); k.type = k.type === 'password' ? 'text' : 'password'; });
  $('#saveKey').addEventListener('click', () => {
    const k = $('#apiKey').value.trim();
    if (k && !/^sk-ant-/.test(k) && !confirm('המפתח לא נראה כמו מפתח Anthropic (sk-ant-...). לשמור בכל זאת?')) return;
    store.saveSettings({ apiKey: k, model: $('#model').value }); renderSettings(); toast(k ? 'המפתח נשמר במכשיר ✓' : 'המפתח נמחק');
  });
  $('#clearKey').addEventListener('click', () => { if (confirm('למחוק את המפתח מהמכשיר?')) { store.saveSettings({ apiKey: '' }); renderSettings(); toast('המפתח נמחק'); } });
  $('#model').addEventListener('change', () => { store.saveSettings({ model: $('#model').value }); toast('המודל עודכן'); });
  $('#testKey').addEventListener('click', async () => {
    const k = $('#apiKey').value.trim(); if (k) store.saveSettings({ apiKey: k });
    $('#keyStatus').textContent = 'בודק…';
    try {
      const r = await callClaude([{ role: 'user', content: 'ענה במילה אחת: תקין' }], { system: 'Answer in Hebrew, one word.', maxTokens: 20 });
      $('#keyStatus').textContent = `✓ החיבור תקין (מודל: ${r.model})`;
    } catch (e) { $('#keyStatus').textContent = '✗ ' + e.message; }
  });
  $('#saveProfile').addEventListener('click', () => { store.saveSettings({ foreman: $('#foreman').value.trim() }); toast('הפרטים נשמרו ✓'); });

  // company settings
  $('#logoFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try { const r = await resizeImage(f); companyLogo.set(r); renderLogoPreview(); toast('הלוגו נשמר ✓'); }
    catch (err) { alert(err.name === 'QuotaExceededError' ? 'התמונה גדולה מדי לשמירה במכשיר' : (err.message || 'שגיאה בטעינת התמונה')); }
  });
  $('#logoClear').addEventListener('click', () => { if (companyLogo.get() && confirm('להסיר את לוגו החברה?')) { companyLogo.clear(); renderLogoPreview(); toast('הלוגו הוסר'); } });
  $('#saveCompany').addEventListener('click', () => {
    const name = $('#company').value.trim(); store.saveSettings({ company: name });
    if (name && !$('#f-company').value) { $('#f-company').value = name; markDirty(); }
    fillSites(); toast('פרטי החברה נשמרו ✓');
  });

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
  $('#xlsxRangeBtn').addEventListener('click', () => runExport(rangeEntries(), { siteLabel: $('#xSite').value || undefined }));
  $('#xSheetDownload').addEventListener('click', () => { if (lastExport) downloadBlob(lastExport.blob, lastExport.filename); });
  $('#xSheetShare').addEventListener('click', async () => {
    if (!lastExport) return;
    const file = new File([lastExport.blob], lastExport.filename, { type: lastExport.blob.type });
    try { await navigator.share({ files: [file], title: lastExport.filename }); }
    catch (e) { if (e.name !== 'AbortError') downloadBlob(lastExport.blob, lastExport.filename); }
  });
  $('#xSheetClose').addEventListener('click', () => { $('#xSheet').hidden = true; });
  $('#xSheet').addEventListener('click', (e) => { if (e.target.id === 'xSheet') $('#xSheet').hidden = true; });

  // network status
  const net = () => { $('#netStatus').classList.toggle('off', !navigator.onLine); $('#netStatus').title = navigator.onLine ? 'מחובר' : 'אופליין'; };
  window.addEventListener('online', net); window.addEventListener('offline', net); net();

  loadDate(todayISO());
  renderSettings();

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
