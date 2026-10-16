/* BMB · ייצוא לאקסל – builds an RTL .xlsx with ExcelJS (vendored in vendor/exceljs.min.js, loaded on demand, works offline).
 * Depends on helpers from app.js: store, weekday, fmtDate, parseISO, minutesBetween, CREW_TYPES, crewLine, bulletize, companyLogo.
 */
'use strict';

const XL = {
  NAVY: 'FF14213D', NAVY2: 'FF21406F', AMBER: 'FFF59E0B', AMBER_L: 'FFFEF3C7', ZEBRA: 'FFF5F7FB', SUB: 'FFE3E9F4', LINE: 'FFC9D1E0', WHITE: 'FFFFFFFF',
  FONT: 'Arial',
};

let excelJsPromise = null;
function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  if (!excelJsPromise) {
    excelJsPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/exceljs.min.js';
      s.onload = () => (window.ExcelJS ? resolve(window.ExcelJS) : reject(new Error('ExcelJS failed')));
      s.onerror = () => { excelJsPromise = null; reject(new Error('לא ניתן לטעון את רכיב האקסל')); };
      document.head.appendChild(s);
    });
  }
  return excelJsPromise;
}

async function bmbLogoBase64() {
  try {
    const r = await fetch('icons/icon-192.png');
    const buf = new Uint8Array(await r.arrayBuffer());
    let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(bin);
  } catch { return null; }
}

const xlDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const hoursNum = (e) => { const m = minutesBetween(e.start, e.end); return m == null ? null : Math.round((m / 60) * 100) / 100; };
const thin = { style: 'thin', color: { argb: XL.LINE } };
const BORDER = { top: thin, left: thin, bottom: thin, right: thin };

function estHeight(row, widths) {
  let lines = 1;
  row.eachCell((cell, col) => {
    const v = cell.value; if (v == null || typeof v !== 'string') return;
    const w = Math.max(4, (widths[col - 1] || 10) - 1);
    const n = v.split('\n').reduce((a, l) => a + Math.max(1, Math.ceil((l.length * 1.05) / w)), 0);
    lines = Math.max(lines, n);
  });
  return Math.max(20, lines * 15 + 5);
}

const EMU = 9525; // EMU per pixel
function placeImage(ws, id, col0, wPx, hPx, offX = 6, offY = 6) {
  const colPx = (c) => Math.trunc((ws.getColumn(c + 1).width || 9) * 7 + 5);
  const rowPx = (r) => ((ws.getRow(r + 1).height || 15) * 4) / 3;
  const walk = (start, off, size, unit) => { let i = start, rem = off + size; while (rem > unit(i)) { rem -= unit(i); i++; } return [i, rem]; };
  const [c2, x2] = walk(col0, offX, wPx, colPx);
  const [r2, y2] = walk(0, offY, hPx, rowPx);
  ws.addImage(id, {
    tl: { nativeCol: col0, nativeColOff: offX * EMU, nativeRow: 0, nativeRowOff: offY * EMU },
    br: { nativeCol: c2, nativeColOff: Math.round(x2 * EMU), nativeRow: r2, nativeRowOff: Math.round(y2 * EMU) },
    editAs: 'oneCell',
  });
}

/** Title block (rows 1-5) with company logo (column A side) and small BMB logo (far side). Returns first free row. */
function titleBlock(wb, ws, ncols, meta, imgs) {
  const heights = [30, 22, 19, 19, 5];
  heights.forEach((h, i) => { ws.getRow(i + 1).height = h; });
  const c1 = ncols <= 6 ? 2 : 3, c2 = ncols - 1; // title spans the middle columns
  const lines = [
    { t: 'יומן עבודה' + (meta.subtitle ? ` – ${meta.subtitle}` : ''), font: { size: 18, bold: true, color: { argb: XL.NAVY } } },
    { t: meta.company || '', font: { size: 14, bold: true, color: { argb: XL.NAVY2 } } },
    { t: [meta.site ? `אתר: ${meta.site}` : '', `תקופה: ${meta.range}`].filter(Boolean).join('   ·   '), font: { size: 11, color: { argb: 'FF333B4D' } } },
    { t: [meta.foreman ? `מנהל עבודה: ${meta.foreman}` : '', `הופק: ${meta.generated}`, 'BMB · Ben Menachem Bari'].filter(Boolean).join('   ·   '), font: { size: 9.5, color: { argb: 'FF6B7385' } } },
  ];
  lines.forEach((l, i) => {
    ws.mergeCells(i + 1, c1, i + 1, c2);
    const cell = ws.getCell(i + 1, c1);
    cell.value = l.t; cell.font = { name: XL.FONT, ...l.font };
    cell.alignment = { horizontal: 'center', vertical: 'middle', readingOrder: 'rtl', shrinkToFit: i >= 2 };
  });
  for (let c = 1; c <= ncols; c++) ws.getCell(5, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL.AMBER } };
  // images (two-cell anchors computed in pixels → valid OOXML, keeps aspect ratio)
  if (imgs.company) {
    const maxH = 84, maxW = 170;
    const k = Math.min(maxH / imgs.company.h, maxW / imgs.company.w);
    placeImage(ws, imgs.company.id, 0, Math.round(imgs.company.w * k), Math.round(imgs.company.h * k));
  }
  if (imgs.bmb != null) placeImage(ws, imgs.bmb, ncols - 1, 54, 54, 10, 8);
  return 6;
}

function headerRow(ws, r, headers) {
  const row = ws.getRow(r);
  headers.forEach((h, i) => {
    const c = row.getCell(i + 1);
    c.value = h;
    c.font = { name: XL.FONT, bold: true, size: 11, color: { argb: XL.WHITE } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL.NAVY } };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true, readingOrder: 'rtl' };
    c.border = { top: thin, bottom: { style: 'medium', color: { argb: XL.AMBER } }, left: thin, right: thin };
  });
  row.height = 40;
}

function styleData(row, ncols, { zebra = false, fill = null, bold = false, color = null, center = [] } = {}) {
  for (let c = 1; c <= ncols; c++) {
    const cell = row.getCell(c);
    cell.font = { name: XL.FONT, size: 10.5, bold, color: color ? { argb: color } : undefined };
    cell.border = BORDER;
    cell.alignment = { vertical: 'top', horizontal: center.includes(c) ? 'center' : 'right', wrapText: true, readingOrder: 'rtl' };
    const f = fill || (zebra ? XL.ZEBRA : null);
    if (f) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: f } };
  }
}

function baseSheet(wb, name, widths) {
  const ws = wb.addWorksheet(name, {
    views: [{ rightToLeft: true, state: 'frozen', ySplit: 6, showGridLines: false }],
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } },
    headerFooter: { oddFooter: '&C&8BMB · Ben Menachem Bari   &P / &N' },
  });
  ws.columns = widths.map((w) => ({ width: w }));
  ws.pageSetup.printTitlesRow = '6:6';
  return ws;
}

/** Build workbook for entries (array, any order). Returns { blob, filename }. */
async function buildWorkbook(entries, opts = {}) {
  const ExcelJS = await loadExcelJS();
  const s = store.settings();
  const list = [...entries].sort((a, b) => a.date.localeCompare(b.date));
  const from = list[0].date, to = list[list.length - 1].date;
  const sites = [...new Set(list.map((e) => (e.site || '').trim()).filter(Boolean))];
  const companies = [...new Set(list.map((e) => (e.company || '').trim()).filter(Boolean))];
  const meta = {
    company: companies.length === 1 ? companies[0] : (s.company || companies.join(', ')),
    site: sites.length <= 3 ? sites.join(', ') : `${sites.length} אתרים`,
    range: from === to ? `${weekday(from)} ${fmtDate(from)}` : `${fmtDate(from)} – ${fmtDate(to)}`,
    foreman: s.foreman,
    generated: `${fmtDate(todayISO())} ${new Date().toTimeString().slice(0, 5)}`,
  };

  const wb = new ExcelJS.Workbook();
  wb.creator = 'BMB · Ben Menachem Bari'; wb.created = new Date(); wb.title = 'יומן עבודה';
  const imgs = { company: null, bmb: null };
  const logo = companyLogo.get();
  if (logo && logo.dataUrl) {
    const ext = /^data:image\/jpe?g/.test(logo.dataUrl) ? 'jpeg' : 'png';
    imgs.company = { id: wb.addImage({ base64: logo.dataUrl.split(',')[1], extension: ext }), w: logo.w, h: logo.h };
  }
  const bmb = await bmbLogoBase64();
  if (bmb) imgs.bmb = wb.addImage({ base64: bmb, extension: 'png' });

  /* ---------- Sheet 1: ריכוז ---------- */
  {
    const W = [13, 10, 24, 9, 9, 10, 14, 9, 32, 52, 36];
    const H = ['תאריך', 'יום', 'אתר', 'התחלה', 'סיום', 'סה״כ שעות', 'מזג אוויר', 'עובדים', 'נוכחים וציוד', 'עבודות שבוצעו', 'הערות'];
    const ws = baseSheet(wb, 'ריכוז', W);
    let r = titleBlock(wb, ws, W.length, meta, imgs);
    headerRow(ws, r, H); const first = r + 1;
    list.forEach((e, i) => {
      const crew = (e.crew || []).filter((c) => (c.name || '').trim());
      const workers = crew.filter((c) => c.type === 'פועלים' || c.type === 'קבלן משנה').reduce((a, c) => a + (Number(c.count) || 0), 0);
      const row = ws.getRow(++r);
      row.values = [xlDate(e.date), weekday(e.date).replace(/^יום\s*/, ''), e.site || '', e.start || '', e.end || '', hoursNum(e),
        e.weather || '', workers || null, crew.map((c) => crewLine(c)).join('\n'), bulletize(e.work || ''), bulletize(e.notes || '')];
      styleData(row, W.length, { zebra: i % 2 === 1, center: [1, 2, 4, 5, 6, 8] });
      row.getCell(1).numFmt = 'dd/mm/yyyy'; row.getCell(6).numFmt = '0.0#';
      row.height = estHeight(row, W);
    });
    const last = r;
    const tot = ws.getRow(++r);
    const totalHours = list.reduce((a, e) => a + (hoursNum(e) || 0), 0);
    tot.values = ['סה״כ', `${list.length} ימים`, '', '', '', { formula: `SUM(F${first}:F${last})`, result: Math.round(totalHours * 100) / 100 },
      '', { formula: `SUM(H${first}:H${last})`, result: list.reduce((a, e) => a + (e.crew || []).filter((c) => c.type === 'פועלים' || c.type === 'קבלן משנה').reduce((x, c) => x + (Number(c.count) || 0), 0), 0) }, '', '', ''];
    styleData(tot, W.length, { fill: XL.NAVY, bold: true, color: XL.WHITE, center: [1, 2, 6, 8] });
    tot.getCell(6).numFmt = '0.0#'; tot.height = 24;
    ws.autoFilter = { from: { row: 6, column: 1 }, to: { row: last, column: W.length } };
  }

  /* ---------- Sheet 2: לפי קבלן ---------- */
  const groups = new Map();
  list.forEach((e) => (e.crew || []).forEach((c) => {
    const name = (c.name || '').trim(); if (!name) return;
    const type = CREW_TYPES.includes(c.type) ? c.type : 'אחר';
    const key = `${type}|${name}`;
    if (!groups.has(key)) groups.set(key, { type, name, rows: [] });
    groups.get(key).rows.push({ e, count: Number(c.count) || 1, hours: hoursNum(e) });
  }));
  const ordered = [...groups.values()].sort((a, b) => CREW_TYPES.indexOf(a.type) - CREW_TYPES.indexOf(b.type) || a.name.localeCompare(b.name, 'he'));
  const summary = [];
  {
    const W = [26, 12, 13, 10, 26, 13, 11, 16];
    const H = ['קבלן / צוות / ציוד', 'סוג', 'תאריך', 'יום', 'אתר', 'כמות (עובדים / יח׳)', 'שעות עבודה', 'סה״כ שעות (כמות × שעות)'];
    const ws = baseSheet(wb, 'לפי קבלן', W);
    let r = titleBlock(wb, ws, W.length, { ...meta, subtitle: 'פירוט לפי קבלן' }, imgs);
    headerRow(ws, r, H); const top = r + 1;
    if (!ordered.length) {
      const row = ws.getRow(++r); ws.mergeCells(r, 1, r, W.length); row.getCell(1).value = 'לא נרשמו נוכחים בתקופה זו';
      styleData(row, W.length, {});
    }
    ordered.forEach((g) => {
      // group header
      const gh = ws.getRow(++r); ws.mergeCells(r, 1, r, W.length);
      gh.getCell(1).value = `${g.name}  ·  ${g.type}`;
      styleData(gh, W.length, { fill: XL.AMBER_L, bold: true, color: 'FF7A3E00' }); gh.height = 22;
      const first = r + 1;
      g.rows.sort((a, b) => a.e.date.localeCompare(b.e.date)).forEach((x, i) => {
        const row = ws.getRow(++r);
        const mh = x.hours == null ? null : Math.round(x.hours * x.count * 100) / 100;
        row.values = [g.name, g.type, xlDate(x.e.date), weekday(x.e.date).replace(/^יום\s*/, ''), x.e.site || '', x.count, x.hours,
          x.hours == null ? null : { formula: `F${r}*G${r}`, result: mh }];
        row.outlineLevel = 1;
        styleData(row, W.length, { zebra: i % 2 === 1, center: [2, 3, 4, 6, 7, 8] });
        row.getCell(3).numFmt = 'dd/mm/yyyy'; row.getCell(7).numFmt = '0.0#'; row.getCell(8).numFmt = '0.0#';
      });
      const last = r;
      const days = new Set(g.rows.map((x) => x.e.date)).size;
      const sumCount = g.rows.reduce((a, x) => a + x.count, 0);
      const sumHours = Math.round(g.rows.reduce((a, x) => a + (x.hours || 0), 0) * 100) / 100;
      const sumMH = Math.round(g.rows.reduce((a, x) => a + (x.hours || 0) * x.count, 0) * 100) / 100;
      summary.push({ ...g, days, sumCount, sumHours, sumMH });
      const st = ws.getRow(++r);
      st.values = [`סה״כ – ${g.name}`, g.type, 'ימי נוכחות:', days, '',
        { formula: `SUBTOTAL(9,F${first}:F${last})`, result: sumCount },
        { formula: `SUBTOTAL(9,G${first}:G${last})`, result: sumHours },
        { formula: `SUBTOTAL(9,H${first}:H${last})`, result: sumMH }];
      styleData(st, W.length, { fill: XL.SUB, bold: true, color: XL.NAVY, center: [2, 4, 6, 7, 8] });
      st.getCell(7).numFmt = '0.0#'; st.getCell(8).numFmt = '0.0#'; st.height = 22;
      ws.getRow(++r).height = 8; // spacer
    });
    if (ordered.length) {
      const allDays = new Set(ordered.flatMap((g) => g.rows.map((x) => x.e.date))).size;
      const gt = ws.getRow(++r);
      gt.values = ['סה״כ כללי', `${ordered.length} פריטים`, 'ימי עבודה:', allDays, '',
        { formula: `SUBTOTAL(9,F${top}:F${r - 1})`, result: summary.reduce((a, g) => a + g.sumCount, 0) },
        { formula: `SUBTOTAL(9,G${top}:G${r - 1})`, result: Math.round(summary.reduce((a, g) => a + g.sumHours, 0) * 100) / 100 },
        { formula: `SUBTOTAL(9,H${top}:H${r - 1})`, result: Math.round(summary.reduce((a, g) => a + g.sumMH, 0) * 100) / 100 }];
      styleData(gt, W.length, { fill: XL.NAVY, bold: true, color: XL.WHITE, center: [2, 4, 6, 7, 8] });
      gt.getCell(7).numFmt = '0.0#'; gt.getCell(8).numFmt = '0.0#'; gt.height = 26;
    }
    ws.properties.outlineProperties = { summaryBelow: true };
  }

  /* ---------- Sheet 3: סיכום קבלנים ---------- */
  if (summary.length) {
    const W = [30, 13, 13, 18, 14, 20];
    const H = ['קבלן / צוות / ציוד', 'סוג', 'ימי נוכחות', 'סה״כ כמות (ימי עבודה)', 'סה״כ שעות', 'סה״כ שעות (כמות × שעות)'];
    const ws = baseSheet(wb, 'סיכום קבלנים', W);
    let r = titleBlock(wb, ws, W.length, { ...meta, subtitle: 'סיכום קבלנים' }, imgs);
    headerRow(ws, r, H); const first = r + 1;
    summary.forEach((g, i) => {
      const row = ws.getRow(++r);
      row.values = [g.name, g.type, g.days, g.sumCount, g.sumHours, g.sumMH];
      styleData(row, W.length, { zebra: i % 2 === 1, center: [2, 3, 4, 5, 6] });
      row.getCell(5).numFmt = '0.0#'; row.getCell(6).numFmt = '0.0#'; row.height = 20;
    });
    const t = ws.getRow(++r);
    t.values = ['סה״כ', '', '', { formula: `SUM(D${first}:D${r - 1})`, result: summary.reduce((a, g) => a + g.sumCount, 0) },
      { formula: `SUM(E${first}:E${r - 1})`, result: Math.round(summary.reduce((a, g) => a + g.sumHours, 0) * 100) / 100 },
      { formula: `SUM(F${first}:F${r - 1})`, result: Math.round(summary.reduce((a, g) => a + g.sumMH, 0) * 100) / 100 }];
    styleData(t, W.length, { fill: XL.NAVY, bold: true, color: XL.WHITE, center: [4, 5, 6] });
    t.getCell(5).numFmt = '0.0#'; t.getCell(6).numFmt = '0.0#'; t.height = 24;
  }

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const safe = (x) => String(x).replace(/[\\/:*?"<>|]+/g, '').replace(/[–—]/g, '-').trim().replace(/\s+/g, '_').replace(/_?-_?/g, '-').slice(0, 40);
  const siteName = opts.siteLabel || (sites.length === 1 ? sites[0] : sites.length ? 'כל_האתרים' : 'ללא_אתר');
  const d = (iso) => iso.split('-').reverse().join('.');
  const filename = `יומן_עבודה_${safe(siteName)}_${from === to ? d(from) : `${d(from)}-${d(to)}`}.xlsx`;
  return { blob, filename, stats: { days: list.length, contractors: summary.length } };
}
