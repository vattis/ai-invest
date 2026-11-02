export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function supabase(env = process.env, fetcher = fetch, service = false) {
  const key = service ? env.SUPABASE_SERVICE_ROLE_KEY : env.SUPABASE_ANON_KEY;
  if (!env.SUPABASE_URL || !key) throw new HttpError(503, 'Supabase 연결 설정이 필요합니다.');
  const base = env.SUPABASE_URL.replace(/\/$/, '');
  return async (path, { token, method = 'GET', body, headers = {} } = {}) => {
    const response = await fetcher(base + path, {
      method, headers: { apikey: key, Authorization: `Bearer ${token ?? key}`, 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000)
    });
    const raw = await response.text();
    let data; try { data = raw ? JSON.parse(raw) : null; } catch { throw new HttpError(502, '외부 서비스 응답을 읽을 수 없습니다.'); }
    if (!response.ok) {
      const status = response.status === 409 || data?.code === '40001' ? 409 : response.status;
      throw new HttpError(status, status === 409 ? '설정이 변경되었습니다. 새로고침 후 다시 저장하세요.' :
        status === 429 ? '요청 한도에 도달했습니다. 잠시 후 다시 시도하세요.' :
        status === 401 || status === 403 ? '인증 또는 접근 권한을 확인하세요.' : '외부 서비스 요청이 실패했습니다.');
    }
    return data;
  };
}
