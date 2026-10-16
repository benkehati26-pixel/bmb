// BMB admin user management. Caller must be an active admin (checked server-side).
// Uses SUPABASE_SERVICE_ROLE_KEY (auto-provided to edge functions) – never sent to the client.
import { createClient } from 'npm:@supabase/supabase-js@2';

const ALLOWED_ORIGINS = ['https://benkehati26-pixel.github.io', 'http://localhost:8765', 'http://127.0.0.1:8765'];
const DOMAIN = 'bmb.local';
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
const USERNAME_RE = /^[a-z0-9._-]{2,32}$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  if (req.method !== 'POST') return json(req, 405, { error: 'method not allowed' });
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: u } = token ? await sb.auth.getUser(token) : { data: null };
  if (!u?.user) return json(req, 401, { error: 'נדרשת התחברות' });
  const { data: me } = await sb.from('profiles').select('role, disabled').eq('id', u.user.id).single();
  if (!me || me.disabled || me.role !== 'admin') return json(req, 403, { error: 'פעולה למנהל בלבד' });

  let b: any; try { b = await req.json(); } catch { return json(req, 400, { error: 'בקשה לא תקינה' }); }
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });

  try {
    switch (b.action) {
      case 'list': {
        const { data: profs, error } = await sb.from('profiles').select('*').order('created_at');
        if (error) throw error;
        const { data: usage } = await sb.from('ai_usage').select('user_id, calls').eq('day', day);
        const { data: counts } = await sb.from('logs').select('user_id');
        const emails: Record<string, { email: string; last: string | null }> = {};
        const { data: au } = await sb.auth.admin.listUsers({ perPage: 1000 });
        (au?.users || []).forEach((x) => { emails[x.id] = { email: x.email || '', last: x.last_sign_in_at || null }; });
        return json(req, 200, {
          users: (profs || []).map((p) => ({
            ...p, email: emails[p.id]?.email || '', last_sign_in_at: emails[p.id]?.last || null,
            ai_today: usage?.find((x) => x.user_id === p.id)?.calls || 0,
            logs: (counts || []).filter((x) => x.user_id === p.id).length,
          })),
        });
      }
      case 'create': {
        const username = String(b.username || '').trim().toLowerCase();
        const password = String(b.password || '');
        if (!USERNAME_RE.test(username)) return json(req, 400, { error: 'שם משתמש: 2–32 תווים, אותיות באנגלית קטנות / ספרות / . _ -' });
        if (password.length < 8) return json(req, 400, { error: 'סיסמה: לפחות 8 תווים' });
        const { data: exists } = await sb.from('profiles').select('id').eq('username', username).maybeSingle();
        if (exists) return json(req, 409, { error: 'שם המשתמש כבר קיים' });
        const email = String(b.email || '').trim().toLowerCase() || `${username}@${DOMAIN}`;
        const { data: cu, error } = await sb.auth.admin.createUser({
          email, password, email_confirm: true,
          user_metadata: { username, display_name: String(b.display_name || '').trim() },
        });
        if (error) throw error;
        const role = b.role === 'admin' ? 'admin' : 'user';
        await sb.from('profiles').upsert({ id: cu.user!.id, username, display_name: String(b.display_name || '').trim(), role, ai_enabled: b.ai_enabled !== false });
        return json(req, 200, { ok: true, id: cu.user!.id });
      }
      case 'update': {
        const id = String(b.id || '');
        if (!id) return json(req, 400, { error: 'חסר משתמש' });
        const patch: Record<string, unknown> = {};
        if (typeof b.display_name === 'string') patch.display_name = b.display_name.trim().slice(0, 80);
        if (typeof b.ai_enabled === 'boolean') patch.ai_enabled = b.ai_enabled;
        if (typeof b.disabled === 'boolean') {
          if (id === u.user.id && b.disabled) return json(req, 400, { error: 'אי אפשר להשבית את עצמך' });
          patch.disabled = b.disabled;
          await sb.auth.admin.updateUserById(id, { ban_duration: b.disabled ? '876000h' : 'none' });
        }
        if (b.role === 'admin' || b.role === 'user') {
          if (id === u.user.id && b.role !== 'admin') return json(req, 400, { error: 'אי אפשר להסיר הרשאת מנהל מעצמך' });
          patch.role = b.role;
        }
        if (Object.keys(patch).length) { const { error } = await sb.from('profiles').update(patch).eq('id', id); if (error) throw error; }
        return json(req, 200, { ok: true });
      }
      case 'reset_password': {
        const id = String(b.id || ''), password = String(b.password || '');
        if (password.length < 8) return json(req, 400, { error: 'סיסמה: לפחות 8 תווים' });
        const { error } = await sb.auth.admin.updateUserById(id, { password });
        if (error) throw error;
        return json(req, 200, { ok: true });
      }
      case 'delete': {
        const id = String(b.id || '');
        if (id === u.user.id) return json(req, 400, { error: 'אי אפשר למחוק את עצמך' });
        const { error } = await sb.auth.admin.deleteUser(id);
        if (error) throw error;
        return json(req, 200, { ok: true });
      }
      default: return json(req, 400, { error: 'פעולה לא מוכרת' });
    }
  } catch (e) {
    console.log('admin-users error', e);
    return json(req, 500, { error: (e as Error).message || 'שגיאת שרת' });
  }
});
