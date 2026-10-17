// BMB AI assistant – server-side Gemini proxy.
// Verifies the caller's Supabase JWT, checks profile (active + ai_enabled, admin always allowed),
// applies a per-user daily limit, then calls Gemini with the fixed work-log prompt.
// Secrets: GEMINI_API_KEY (function secret). Never returned to the client.
import { createClient } from 'npm:@supabase/supabase-js@2';

const DAILY_LIMIT = Number(Deno.env.get('AI_DAILY_LIMIT') || 50);
const MODELS = (Deno.env.get('GEMINI_MODELS') || 'gemini-flash-latest,gemini-3.5-flash,gemini-2.5-flash,gemini-flash-lite-latest')
  .split(',').map((s) => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = ['https://benkehati26-pixel.github.io', 'http://localhost:8765', 'http://127.0.0.1:8765'];

const SYSTEM_PROMPT = `You are the assistant of an Israeli construction site foreman (מנהל עבודה) at BMB (Ben Menachem Bari). The foreman you are talking to: {{NAME}}.
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
- Hebrew only in values (except proper names/numbers).

Photos: the foreman may attach photos to a message (site work, delivery notes / תעודות משלוח, equipment, handwritten notes, whiteboards, plans). Read them carefully and use them together with his text:
- Delivery note (תעודת משלוח / חשבונית / תעודת שקילה): add to "notes" one line per delivery, e.g. "• התקבלה אספקה: בטון ב-30, 12 קוב – ספק: רדימיקס (ת.מ. 45871)." Use only what is legible: material, quantity + unit, supplier, document number, time if shown.
- Handwritten note / whiteboard: transcribe it into the right fields (crew, hours, work, notes), fixing spelling.
- Site / work photo: add to "work" only work that is clearly visible or confirmed by his text, in professional terms. Equipment clearly working on site (מחפר, מנוף, משאבת בטון...) may be added to "crew" as "ציוד".
- Never guess unreadable numbers or names; if something important is unclear in a photo, say so briefly in "reply" and ask.
- In "reply", mention in one short sentence what you read from the photos.`;

function cors(req: Request) {
  const o = req.headers.get('origin') || '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}
const json = (req: Request, status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'content-type': 'application/json; charset=utf-8' } });

type Img = { mime: string; data: string };
type Msg = { role: 'user' | 'assistant'; content: string; images?: Img[] };
const MAX_IMAGES = 4, MAX_IMAGE_B64 = 3_000_000, IMG_MIME = ['image/jpeg', 'image/png', 'image/webp'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  if (req.method !== 'POST') return json(req, 405, { error: 'method not allowed' });

  const url = Deno.env.get('SUPABASE_URL')!;
  const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json(req, 401, { error: 'נדרשת התחברות' });
  const { data: u, error: ue } = await service.auth.getUser(token);
  if (ue || !u?.user) return json(req, 401, { error: 'ההתחברות פגה – התחבר מחדש' });
  const uid = u.user.id;
  const { data: prof } = await service.from('profiles').select('role, ai_enabled, disabled, display_name, username').eq('id', uid).single();
  if (!prof || prof.disabled) return json(req, 403, { error: 'המשתמש מושבת' });
  const isAdmin = prof.role === 'admin';
  if (!isAdmin && !prof.ai_enabled) return json(req, 403, { error: 'עוזר ה-AI לא הופעל עבורך. פנה למנהל.' });

  let body: { messages?: Msg[]; ping?: boolean };
  try { body = await req.json(); } catch { return json(req, 400, { error: 'בקשה לא תקינה' }); }

  if (body.ping) {
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
    const { data: us } = await service.from('ai_usage').select('calls').eq('user_id', uid).eq('day', day).maybeSingle();
    return json(req, 200, { ok: true, used: us?.calls || 0, limit: DAILY_LIMIT, models: MODELS });
  }

  const msgs = Array.isArray(body.messages) ? body.messages.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') : [];
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return json(req, 400, { error: 'אין הודעה' });
  const trimmed = msgs.slice(-20);
  const total = trimmed.reduce((a, m) => a + m.content.length, 0);
  if (total > 40000) return json(req, 413, { error: 'השיחה ארוכה מדי – התחל שיחה חדשה' });
  // images: only on the latest user message
  const last = trimmed[trimmed.length - 1];
  const imgs = Array.isArray(last.images) ? last.images : [];
  if (imgs.length > MAX_IMAGES) return json(req, 400, { error: `אפשר לצרף עד ${MAX_IMAGES} תמונות להודעה` });
  for (const im of imgs) {
    if (!im || typeof im.data !== 'string' || !IMG_MIME.includes(im.mime)) return json(req, 400, { error: 'סוג תמונה לא נתמך' });
    if (im.data.length > MAX_IMAGE_B64) return json(req, 413, { error: 'תמונה גדולה מדי' });
  }

  const { data: n, error: be } = await service.rpc('ai_bump', { p_user: uid, p_limit: DAILY_LIMIT });
  if (be) return json(req, 500, { error: 'שגיאת שרת (מונה)' });
  if (!isAdmin && (n as number) > DAILY_LIMIT) return json(req, 429, { error: `הגעת למכסה היומית (${DAILY_LIMIT} בקשות). נסה שוב מחר.` });

  const key = Deno.env.get('GEMINI_API_KEY');
  if (!key) return json(req, 500, { error: 'מפתח AI לא מוגדר בשרת' });
  const contents: { role: string; parts: Record<string, unknown>[] }[] = trimmed.map((m, i) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [
      ...(i === trimmed.length - 1 ? imgs.map((im) => ({ inline_data: { mime_type: im.mime, data: im.data } })) : []),
      { text: m.content + (i === trimmed.length - 1 && imgs.length ? `\n\n[צורפו ${imgs.length} תמונות]` : '') },
    ],
  }));
  while (contents.length && contents[0].role !== 'user') contents.shift();

  let lastErr = '';
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response;
      try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT.replace('{{NAME}}', String(prof.display_name || prof.username).slice(0, 60)) }] },
            contents,
            generationConfig: { temperature: 0.2, maxOutputTokens: 4096, responseMimeType: 'application/json' },
          }),
          signal: AbortSignal.timeout(imgs.length ? 70000 : 45000),
        });
      } catch (e) { lastErr = `network: ${String(e).slice(0, 80)}`; continue; }
      if (res.ok) {
        const d = await res.json();
        const text = (d.candidates?.[0]?.content?.parts || []).filter((p: any) => !p.thought).map((p: any) => p.text || '').join('');
        if (text) return json(req, 200, { text, model: d.modelVersion || model, used: n, limit: DAILY_LIMIT });
        lastErr = `empty (${d.candidates?.[0]?.finishReason || d.promptFeedback?.blockReason || '?'})`;
        break;
      }
      const errText = (await res.text()).slice(0, 200);
      lastErr = `${model} ${res.status}`;
      console.log('gemini error', model, res.status, errText);
      if (res.status === 503 || res.status === 500) { await new Promise((r) => setTimeout(r, 800)); continue; } // retry once, then next model
      break; // 404/429/400 → next model
    }
  }
  return json(req, 503, { error: 'שירות ה-AI עמוס כרגע. נסה שוב בעוד דקה.', detail: lastErr });
});
