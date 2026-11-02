import { HttpError, supabase } from '../lib/supabase.mjs';
import { validateSettings, supported } from '../lib/domain.mjs';

const COOKIE_ACCESS = 'trade_access', COOKIE_REFRESH = 'trade_refresh';
export function readCookies(header = '') {
  return Object.fromEntries(header.split(';').map(v => v.trim().split(/=(.*)/s).slice(0,2)).filter(v => v.length === 2));
}
export function claims(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); } catch { return {}; }
}
function cookies(res, tokens, origin) {
  const suffix = `; Path=/; HttpOnly; SameSite=Strict${origin.startsWith('https://') ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', [
    `${COOKIE_ACCESS}=${tokens?.access_token ?? ''}; Max-Age=${tokens ? Math.min(tokens.expires_in ?? 3600, 86400) : 0}${suffix}`,
    `${COOKIE_REFRESH}=${tokens?.refresh_token ?? ''}; Max-Age=${tokens ? 604800 : 0}${suffix}`
  ]);
}
async function readBody(req) {
  if (req.body !== undefined) {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(raw) > 16384) throw new HttpError(413, '요청이 너무 큽니다.');
    try { return typeof req.body === 'string' ? JSON.parse(req.body) : req.body; } catch { throw new HttpError(400, 'JSON 형식을 확인하세요.'); }
  }
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 16384) throw new HttpError(413, '요청이 너무 큽니다.'); }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'JSON 형식을 확인하세요.'); }
}
export function createHandler(env = process.env, fetcher = fetch) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, value) => { res.statusCode = status; res.end(JSON.stringify(value)); };
    try {
      const origin = env.APP_ORIGIN;
      if (!origin || !env.OWNER_USER_ID) throw new HttpError(503, '서버의 본인 계정·접속 주소 설정이 필요합니다.');
      if (!['GET','POST','PUT'].includes(req.method)) throw new HttpError(405, '지원하지 않는 요청입니다.');
      if (req.method !== 'GET' && req.headers.origin !== origin) throw new HttpError(403, '허용되지 않은 요청 출처입니다.');
      const url = new URL(req.url, origin);
      const route = req.query?.route ?? url.searchParams.get('route') ?? url.pathname.replace(/^\/api\/?/, '');
      const api = supabase(env, fetcher);
      const body = req.method === 'GET' ? {} : await readBody(req);
      if (route === 'login' && req.method === 'POST') {
        if (typeof body.email !== 'string' || typeof body.password !== 'string') throw new HttpError(400, '이메일과 비밀번호를 입력하세요.');
        const data = await api('/auth/v1/token?grant_type=password', { method:'POST', body: {email:body.email, password:body.password} });
        if (data.user?.id !== env.OWNER_USER_ID) throw new HttpError(403, '허용된 계정이 아닙니다.');
        cookies(res, data, origin);
        return send(200, { ok:true });
      }
      const jar = readCookies(req.headers.cookie);
      if (route === 'logout' && req.method === 'POST') {
        if (jar[COOKIE_ACCESS]) await api('/auth/v1/logout?scope=local', {token:jar[COOKIE_ACCESS],method:'POST'}).catch(() => {});
        cookies(res, null, origin); return send(200, {ok:true});
      }
      if (route === 'refresh' && req.method === 'POST') {
        if (!jar[COOKIE_REFRESH]) throw new HttpError(401, '로그인이 필요합니다.');
        const data = await api('/auth/v1/token?grant_type=refresh_token', {method:'POST', body:{refresh_token:jar[COOKIE_REFRESH]}});
        if (data.user?.id !== env.OWNER_USER_ID) throw new HttpError(403, '허용된 계정이 아닙니다.');
        cookies(res, data, origin); return send(200, {ok:true});
      }
      const token = jar[COOKIE_ACCESS];
      if (!token) throw new HttpError(401, '로그인이 필요합니다.');
      // Validate with Supabase before trusting any JWT claims (including aal).
      const user = await api('/auth/v1/user', {token});
      if (user.id !== env.OWNER_USER_ID) throw new HttpError(403, '허용된 계정이 아닙니다.');
      const aal = claims(token).aal;
      if (route === 'session' && req.method === 'GET') return send(200, {email:user.email, aal,
        factors:(user.factors ?? []).filter(x=>x.factor_type==='totp').map(x=>({id:x.id,status:x.status}))});
      if (route === 'mfa/enroll' && req.method === 'POST') {
        if ((user.factors ?? []).some(x=>x.status==='verified')) throw new HttpError(409, '등록된 인증 수단을 사용하세요.');
        // Clean abandoned enrollments, avoiding the factor-count limit on refresh.
        for (const factor of user.factors ?? []) if (factor.status === 'unverified') await api(`/auth/v1/factors/${factor.id}`, {token,method:'DELETE'});
        const data = await api('/auth/v1/factors', {token,method:'POST',body:{factor_type:'totp',friendly_name:'Trading Control'}});
        return send(200, {id:data.id,secret:data.totp?.secret,uri:data.totp?.uri});
      }
      if (route === 'mfa/verify' && req.method === 'POST') {
        if (!/^[0-9]{6}$/.test(body.code ?? '') || !(user.factors ?? []).some(x=>x.id===body.factor_id)) throw new HttpError(400,'인증 코드를 확인하세요.');
        const challenge = await api(`/auth/v1/factors/${body.factor_id}/challenge`,{token,method:'POST',body:{}});
        const data = await api(`/auth/v1/factors/${body.factor_id}/verify`,{token,method:'POST',body:{challenge_id:challenge.id,code:body.code}});
        if (claims(data.access_token).aal !== 'aal2') throw new HttpError(403,'2단계 인증에 실패했습니다.');
        cookies(res,data,origin); return send(200,{ok:true});
      }
      if (aal !== 'aal2') throw new HttpError(403,'2단계 인증을 완료하세요.');
      if (route === 'dashboard' && req.method === 'GET') {
        const period = ['day','week','month'].includes(url.searchParams.get('period')) ? url.searchParams.get('period') : 'day';
        const since = new Date(Date.now() - ({day:1,week:7,month:30}[period])*86400000).toISOString();
        const [settings, workers, runs, totals, audit, accounts, trades] = await Promise.all([
          api('/rest/v1/task_settings?select=*&order=task_key',{token}),
          api('/rest/v1/worker_status?select=*&order=updated_at.desc&limit=1',{token}),
          api(`/rest/v1/task_runs?select=*&created_at=gte.${since}&order=created_at.desc&limit=100`,{token}),
          api('/rest/v1/rpc/usage_summary',{token,method:'POST',body:{p_since:since}}),
          api('/rest/v1/settings_audit?select=*&order=created_at.desc&limit=20',{token}),
          api('/rest/v1/paper_accounts?select=*&order=market,cohort',{token}),
          api('/rest/v1/paper_trades?select=*&order=as_of.desc&limit=30',{token})
        ]);
        return send(200,{settings,worker:workers[0] ?? null,runs,totals,audit,accounts,trades,now:new Date().toISOString(),period});
      }
      if (route === 'settings' && req.method === 'PUT') {
        let value; try { value = validateSettings(body); } catch(e) { throw new HttpError(400,e.message); }
        const workers = await api('/rest/v1/worker_status?select=models,models_at&order=updated_at.desc&limit=1',{token});
        if (!workers[0]?.models_at || Date.now()-Date.parse(workers[0].models_at)>86400000) throw new HttpError(409,'PC를 연결하여 모델 목록을 갱신하세요.');
        if (!supported(workers[0].models ?? [],value.model,value.effort)) throw new HttpError(400,'현재 계정에서 확인된 모델·추론 조합을 선택하세요.');
        const updated = await api('/rest/v1/rpc/update_task_setting',{token,method:'POST',body:{
          p_task_key:value.task_key,p_model:value.model,p_effort:value.effort,p_enabled:value.enabled,p_version:value.version
        }});
        return send(200,updated);
      }
      throw new HttpError(404,'요청을 찾을 수 없습니다.');
    } catch (e) { send(e instanceof HttpError ? e.status : 500,{error:e instanceof HttpError ? e.message : '서버 요청을 처리하지 못했습니다.'}); }
  };
}
export default createHandler();
