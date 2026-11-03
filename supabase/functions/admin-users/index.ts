// 관리자 전용: 직원 계정 생성/수정
// 배포: supabase functions deploy admin-users
// 로그인 아이디는 내부적으로 "<아이디>@<LOGIN_EMAIL_DOMAIN>" 이메일로 저장됩니다 (실제 메일 발송 없음).
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
const fail = (status: number, message: string): never => {
  throw new HttpError(status, message);
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const BAN_FOREVER = '876000h';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const domain = Deno.env.get('LOGIN_EMAIL_DOMAIN') ?? 'vintage.local';

    // 호출한 사람이 활성 관리자인지 확인
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: auth } = await admin.auth.getUser(jwt);
    if (!auth?.user) fail(401, '로그인이 필요합니다');
    const { data: me } = await admin.from('profiles').select('*').eq('id', auth.user!.id).maybeSingle();
    if (!me || !['admin', 'super'].includes(me.role) || !me.active) fail(403, '관리자만 가능합니다');
    if (me.role !== 'super') {
      const { data: ok } = await admin.rpc('license_ok');
      if (ok === false) fail(403, '이용 기간이 만료되었습니다. 총관리자(개발자)에게 문의하세요');
    }

    const body = await req.json().catch(() => ({}));

    // 총관리자(super)는 앱에서 만들거나 부여할 수 없음 (Supabase SQL 로만 지정)
    const checkRoleStore = async (role: string, storeId: unknown, allowSuper = false) => {
      if (!['admin', 'manager', 'cashier', ...(allowSuper ? ['super'] : [])].includes(role)) fail(400, '권한 값이 올바르지 않습니다');
      if (role === 'manager' || role === 'cashier') {
        const { data: s } = await admin.from('stores').select('id').eq('id', Number(storeId)).maybeSingle();
        if (!s) fail(400, '실장/캐셔 계정은 소속 매장을 선택해야 합니다');
      }
    };

    if (body.action === 'create') {
      const username = String(body.username ?? '').trim().toLowerCase();
      const name = String(body.name ?? '').trim();
      const password = String(body.password ?? '');
      const role = String(body.role ?? 'manager');
      if (!/^[a-z0-9_.-]{3,30}$/.test(username)) fail(400, '아이디는 영문 소문자/숫자 3~30자로 입력하세요');
      if (!name) fail(400, '이름을 입력하세요');
      if (password.length < 6) fail(400, '비밀번호는 6자 이상이어야 합니다');
      await checkRoleStore(role, body.store_id);
      const { data: dup } = await admin.from('profiles').select('id').eq('username', username).maybeSingle();
      if (dup) fail(409, '이미 사용 중인 아이디입니다');

      const { data: created, error } = await admin.auth.admin.createUser({
        email: `${username}@${domain}`,
        password,
        email_confirm: true,
      });
      if (error) fail(400, `계정 생성 실패: ${error.message}`);
      const { error: pErr } = await admin.from('profiles').insert({
        id: created.user!.id,
        username,
        name,
        role,
        store_id: role === 'manager' || role === 'cashier' ? Number(body.store_id) : null,
      });
      if (pErr) {
        await admin.auth.admin.deleteUser(created.user!.id);
        fail(400, `계정 생성 실패: ${pErr.message}`);
      }
      return json({ id: created.user!.id });
    }

    if (body.action === 'update') {
      const id = String(body.id ?? '');
      const { data: cur } = await admin.from('profiles').select('*').eq('id', id).maybeSingle();
      if (!cur) fail(404, '사용자를 찾을 수 없습니다');
      if (cur.role === 'super' && me.role !== 'super') fail(403, '총관리자 계정은 수정할 수 없습니다');
      const next = {
        name: body.name !== undefined ? String(body.name).trim() : cur.name,
        role: body.role !== undefined ? String(body.role) : cur.role,
        store_id: body.store_id !== undefined ? body.store_id : cur.store_id,
        active: body.active !== undefined ? !!body.active : cur.active,
      };
      if (!next.name) fail(400, '이름을 입력하세요');
      await checkRoleStore(next.role, next.store_id, cur.role === 'super');
      if (id === me.id && (next.role !== me.role || !next.active)) {
        fail(400, '본인 계정의 관리자 권한/활성 상태는 바꿀 수 없습니다');
      }
      if (body.password !== undefined && body.password !== '' && String(body.password).length < 6) {
        fail(400, '비밀번호는 6자 이상이어야 합니다');
      }

      const authUpdate: Record<string, unknown> = {};
      if (body.password) authUpdate.password = String(body.password);
      if (next.active !== cur.active) authUpdate.ban_duration = next.active ? 'none' : BAN_FOREVER;
      if (Object.keys(authUpdate).length) {
        const { error } = await admin.auth.admin.updateUserById(id, authUpdate);
        if (error) fail(400, `계정 수정 실패: ${error.message}`);
      }
      const { error: pErr } = await admin
        .from('profiles')
        .update({
          name: next.name,
          role: next.role,
          store_id: next.role === 'manager' || next.role === 'cashier' ? Number(next.store_id) : null,
          active: next.active,
        })
        .eq('id', id);
      if (pErr) fail(400, `계정 수정 실패: ${pErr.message}`);
      return json({ ok: true });
    }

    fail(400, '알 수 없는 요청입니다');
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: '서버 오류가 발생했습니다' }, 500);
  }
});
