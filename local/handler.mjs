import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { supported, summarizeUsage, validateSettings } from '../lib/domain.mjs';
import { hashToken, newTotpSecret, verifyPassword, verifyTotp } from './auth.mjs';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const sessionCookie = 'trade_session';
const sessionSeconds = 7 * 86400;
const attempts = new Map();
const json = value => JSON.stringify(value ?? null);
const first = result => result.rows[0] ?? null;

function cookieValue(header = '', name) {
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index >= 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function setCookie(req, res, token) {
  const secure = req.headers.origin?.startsWith('https://') || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${sessionCookie}=${token ?? ''}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? sessionSeconds : 0}${secure ? '; Secure' : ''}`);
}

async function readBody(req, limit) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > limit) throw new HttpError(413, '요청이 너무 큽니다.');
  }
  try { return raw ? JSON.parse(raw) : {}; }
  catch { throw new HttpError(400, 'JSON 형식을 확인하세요.'); }
}

function sameOrigin(req, env) {
  const port = Number(env.PORT) || 3000;
  const allowed = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`, env.APP_ORIGIN].filter(Boolean));
  return allowed.has(req.headers.origin);
}

function workerAuthorized(req, env) {
  const supplied = req.headers['x-worker-token'];
  if (typeof supplied !== 'string' || !env.LOCAL_WORKER_TOKEN) return false;
  const a = Buffer.from(hashToken(supplied), 'hex');
  const b = Buffer.from(hashToken(env.LOCAL_WORKER_TOKEN), 'hex');
  return timingSafeEqual(a, b);
}

function enforceRate(req, kind, limit = 10) {
  const key = `${kind}:${req.socket.remoteAddress ?? 'unknown'}`;
  const now = Date.now();
  const value = attempts.get(key) ?? { count: 0, until: now + 15 * 60000 };
  if (now > value.until) { value.count = 0; value.until = now + 15 * 60000; }
  if (value.count >= limit) throw new HttpError(429, '인증 시도가 너무 많습니다. 잠시 후 다시 시도하세요.');
  value.count++;
  attempts.set(key, value);
}

async function getSession(store, req) {
  const token = cookieValue(req.headers.cookie, sessionCookie);
  if (!token) throw new HttpError(401, '로그인이 필요합니다.');
  const row = await store.run(db => db.query(`select s.token_hash,s.aal,o.user_id,o.email,o.totp_secret,o.totp_verified
    from app_sessions s join app_owner o on o.user_id=s.user_id
    where s.token_hash=$1 and s.expires_at>now()`, [hashToken(token)]));
  const session = first(row);
  if (!session) throw new HttpError(401, '로그인이 필요합니다.');
  return session;
}

async function issueSession(store, req, res, userId, aal) {
  const token = randomBytes(32).toString('base64url');
  await store.run(db => db.query(`insert into app_sessions(token_hash,user_id,aal,expires_at)
    values($1,$2,$3,now()+interval '7 days')`, [hashToken(token), userId, aal]));
  setCookie(req, res, token);
}

async function internal(store, req, url, body) {
  const route = url.pathname.slice('/internal/'.length);
  if (route === 'task_settings' && req.method === 'GET') {
    const match = url.searchParams.get('task_key')?.match(/^eq\.(.+)$/);
    return (await store.run(db => db.query(`select * from task_settings ${match ? 'where task_key=$1' : ''} order by task_key`, match ? [match[1]] : []))).rows;
  }
  if (route === 'worker_status' && req.method === 'POST') {
    await store.run(db => db.query(`insert into worker_status(worker_id,updated_at,settings_versions,models,models_at,rate_limits,rate_limits_at,state,current_job,error)
      values($1,$2,$3::jsonb,$4::jsonb,$5,$6::jsonb,$7,$8,$9,$10)
      on conflict(worker_id) do update set updated_at=excluded.updated_at,settings_versions=excluded.settings_versions,
      models=excluded.models,models_at=excluded.models_at,rate_limits=excluded.rate_limits,
      rate_limits_at=excluded.rate_limits_at,state=excluded.state,current_job=excluded.current_job,error=excluded.error`,
      [body.worker_id, body.updated_at, json(body.settings_versions), json(body.models), body.models_at,
        json(body.rate_limits), body.rate_limits_at, body.state, body.current_job, body.error]));
    return null;
  }
  if (route === 'task_runs' && req.method === 'POST') {
    await store.run(db => db.query(`insert into task_runs(id,job_id,task_key,cohort,config_version,model,effort,status,
      input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,duration_ms,error,created_at,finished_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      on conflict(id) do update set status=excluded.status,input_tokens=excluded.input_tokens,
      cached_input_tokens=excluded.cached_input_tokens,output_tokens=excluded.output_tokens,
      reasoning_output_tokens=excluded.reasoning_output_tokens,total_tokens=excluded.total_tokens,
      duration_ms=excluded.duration_ms,error=excluded.error,finished_at=excluded.finished_at`,
      [body.id,body.job_id,body.task_key,body.cohort,body.config_version,body.model,body.effort,body.status,
        body.input_tokens,body.cached_input_tokens,body.output_tokens,body.reasoning_output_tokens,body.total_tokens,
        body.duration_ms,body.error,body.created_at,body.finished_at]));
    return null;
  }
  if (route === 'paper_accounts' && req.method === 'POST') {
    await store.run(db => db.query(`insert into paper_accounts(market,cohort,cash,equity,positions,updated_at)
      values($1,$2,$3,$4,$5::jsonb,$6) on conflict(market,cohort) do update set
      cash=excluded.cash,equity=excluded.equity,positions=excluded.positions,updated_at=excluded.updated_at`,
      [body.market,body.cohort,body.cash,body.equity,json(body.positions),body.updated_at]));
    return null;
  }
  if (route === 'paper_trades' && req.method === 'POST') {
    await store.run(db => db.query(`insert into paper_trades(id,job_id,market,cohort,symbol,side,quantity,price,fee,as_of,source,reason)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict(id) do nothing`,
      [body.id,body.job_id,body.market,body.cohort,body.symbol,body.side,body.quantity,body.price,
        body.fee,body.as_of,body.source,body.reason]));
    return null;
  }
  throw new HttpError(404, '요청을 찾을 수 없습니다.');
}

export function createLocalHandler(store, env = process.env) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, data) => { res.statusCode = status; res.end(JSON.stringify(data)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!['GET', 'POST', 'PUT'].includes(req.method)) throw new HttpError(405, '지원하지 않는 요청입니다.');
      if (url.pathname.startsWith('/internal/')) {
        if (!workerAuthorized(req, env)) throw new HttpError(403, '접근 권한이 없습니다.');
        const body = req.method === 'GET' ? {} : await readBody(req, 2 * 1024 * 1024);
        return send(200, await internal(store, req, url, body));
      }
      if (!url.pathname.startsWith('/api/')) throw new HttpError(404, '요청을 찾을 수 없습니다.');
      if (req.method !== 'GET' && !sameOrigin(req, env)) throw new HttpError(403, '허용되지 않은 요청 출처입니다.');
      const route = url.pathname.slice('/api/'.length);
      const body = req.method === 'GET' ? {} : await readBody(req, 16384);
      if (route === 'login' && req.method === 'POST') {
        enforceRate(req, 'login');
        const user = first(await store.run(db => db.query('select * from app_owner where lower(email)=lower($1)', [body.email ?? ''])));
        if (!user || !await verifyPassword(body.password, user.password_salt, user.password_hash))
          throw new HttpError(401, '이메일 또는 비밀번호를 확인하세요.');
        await issueSession(store, req, res, user.user_id, 1);
        return send(200, { ok: true });
      }
      if (route === 'logout' && req.method === 'POST') {
        const token = cookieValue(req.headers.cookie, sessionCookie);
        if (token) await store.run(db => db.query('delete from app_sessions where token_hash=$1', [hashToken(token)]));
        setCookie(req, res, null);
        return send(200, { ok: true });
      }
      const session = await getSession(store, req);
      if (route === 'refresh' && req.method === 'POST') {
        await store.run(db => db.query("update app_sessions set expires_at=now()+interval '7 days' where token_hash=$1", [session.token_hash]));
        return send(200, { ok: true });
      }
      if (route === 'session' && req.method === 'GET') return send(200, {
        email: session.email, aal: `aal${session.aal}`,
        factors: session.totp_secret ? [{ id: 'totp', status: session.totp_verified ? 'verified' : 'unverified' }] : []
      });
      if (route === 'mfa/enroll' && req.method === 'POST') {
        if (session.totp_verified) throw new HttpError(409, '등록된 인증 수단을 사용하세요.');
        const secret = newTotpSecret();
        await store.run(db => db.query('update app_owner set totp_secret=$1 where user_id=$2', [secret, session.user_id]));
        return send(200, { id: 'totp', secret,
          uri: `otpauth://totp/${encodeURIComponent(`Trading Control:${session.email}`)}?secret=${secret}&issuer=Trading%20Control` });
      }
      if (route === 'mfa/verify' && req.method === 'POST') {
        enforceRate(req, 'mfa');
        if (body.factor_id !== 'totp' || !session.totp_secret || !verifyTotp(session.totp_secret, body.code))
          throw new HttpError(400, '인증 코드를 확인하세요.');
        await store.run(db => db.query('update app_owner set totp_verified=true where user_id=$1', [session.user_id]));
        await store.run(db => db.query('update app_sessions set aal=2 where token_hash=$1', [session.token_hash]));
        return send(200, { ok: true });
      }
      if (session.aal !== 2 || !session.totp_verified) throw new HttpError(403, '2단계 인증을 완료하세요.');
      if (route === 'dashboard' && req.method === 'GET') {
        const days = { day: 1, week: 7, month: 30 }[url.searchParams.get('period')] ?? 1;
        const since = new Date(Date.now() - days * 86400000).toISOString();
        const data = await store.run(async db => {
          const [settings, workers, runs, usage, audit, accounts, trades] = await Promise.all([
            db.query('select * from task_settings order by task_key'),
            db.query('select * from worker_status order by updated_at desc limit 1'),
            db.query('select * from task_runs where created_at >= $1 order by created_at desc limit 100', [since]),
            db.query('select input_tokens,cached_input_tokens,output_tokens,total_tokens from task_runs where created_at >= $1', [since]),
            db.query('select * from settings_audit order by created_at desc limit 20'),
            db.query('select * from paper_accounts order by market,cohort'),
            db.query('select * from paper_trades order by as_of desc limit 30')
          ]);
          const numeric = usage.rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value === null ? null : Number(value)])));
          return { settings: settings.rows, worker: workers.rows[0] ?? null, runs: runs.rows,
            totals: summarizeUsage(numeric), audit: audit.rows, accounts: accounts.rows, trades: trades.rows,
            now: new Date().toISOString(), period: url.searchParams.get('period') ?? 'day' };
        });
        return send(200, data);
      }
      if (route === 'settings' && req.method === 'PUT') {
        let value;
        try { value = validateSettings(body); } catch (error) { throw new HttpError(400, error.message); }
        const updated = await store.run(async db => {
          await db.exec('begin');
          try {
            const old = first(await db.query('select * from task_settings where task_key=$1 for update', [value.task_key]));
            if (!old || old.version !== value.version) throw new HttpError(409, '설정이 변경되었습니다. 새로고침 후 다시 저장하세요.');
            const worker = first(await db.query('select * from worker_status order by updated_at desc limit 1'));
            if (!worker?.models_at || Date.now() - Date.parse(worker.models_at) > 86400000)
              throw new HttpError(409, 'PC를 연결하여 모델 목록을 갱신하세요.');
            if (!supported(worker.models ?? [], value.model, value.effort))
              throw new HttpError(400, '현재 계정에서 확인된 모델·추론 조합을 선택하세요.');
            const next = first(await db.query(`update task_settings set model=$1,effort=$2,enabled=$3,version=version+1,
              updated_at=now() where task_key=$4 returning *`, [value.model,value.effort,value.enabled,value.task_key]));
            await db.query(`insert into settings_audit(task_key,actor,before_value,after_value)
              values($1,$2,$3::jsonb,$4::jsonb)`, [value.task_key,session.user_id,json(old),json(next)]);
            await db.exec('commit');
            return next;
          } catch (error) { await db.exec('rollback'); throw error; }
        });
        return send(200, updated);
      }
      throw new HttpError(404, '요청을 찾을 수 없습니다.');
    } catch (error) {
      send(error instanceof HttpError ? error.status : 500,
        { error: error instanceof HttpError ? error.message : '서버 요청을 처리하지 못했습니다.' });
    }
  };
}
