# Orbit — 개인 AI 투자 실험 관리 콘솔

국내 20종목·미국 20종목의 A/B 모의투자 실험을 위한 **시세 수집, AI 판단, 가상 체결, 모바일 대시보드**입니다. A는 전일 피드백을 다음 판단에 받고 B는 받지 않습니다. 두 그룹은 같은 종목·시세·모델 설정으로 시작합니다. 기존 Java/Spring Boot 프로젝트는 그대로 보존했습니다. Node.js 22 이상을 사용합니다.

## 구현 범위

- 모바일 대응 대시보드, 기간별 봇 사용 토큰과 최근 작업, 모델 설정·변경 이력.
- 국내/미국 매매 판단과 피드백별 모델·추론 수준·활성 상태 설정.
- 계정에서 조회된 모델/추론 조합만 허용. 낙관적 잠금으로 동시 저장 충돌 방지.
- PC가 10초 간격으로 설정을 수신. 작업 시작 시 설정을 읽어 A/B에 같은 버전을 고정. 진행 중인 작업은 변경하지 않음.
- `codex exec` JSONL에서 실제 사용량 기록. 캐시 입력과 추론 출력은 중복 합산하지 않음. 실패한 실행의 확인 가능한 사용량도 기록.
- Codex app-server로 계정 모델 목록과 전체 한도 조회. 계정 한도와 이 봇의 작업 토큰은 별도 지표.
- 이메일/비밀번호 + 필수 TOTP MFA. 지정한 단일 소유자 UUID만 허용. HttpOnly/SameSite 쿠키, 변경 API 출처 검사, Supabase RLS.
- 로컬 파일 작업 큐, 실행 시간 제한, 결과 검증, 설정 버전 기록, 전송 실패 시 outbox 재전송, 중단된 작업 자동 재실행 방지.
- 한국투자증권 국내 KRX 시세와 Alpaca 미국 IEX 시세를 수집해 정규장 15분 구간에 최대 20회/시장/일 판단 작업 생성. 시장 종목은 `config/universe.json`에서 각 20개로 조정 가능.
- 같은 작업의 A/B 판단이 모두 끝난 뒤 새 시세로 가상 체결. 보유 현금과 최대 20%/종목 제한, 설정한 수수료·슬리피지를 적용. 종가 후 시장별 피드백 작업을 생성하고 A에만 반영.
- 4개 가상 계좌 잔고와 최근 가상 체결을 인증된 모바일 대시보드에 표시.

**실제 증권사 주문은 연결하지 않습니다.** 미국 무료 IEX는 미국 전체 거래소 시세가 아닙니다. KRX/NXT 통합 시세도 아니며, 휴장일 일정은 별도 조회하지 않고 새 시세가 부족하면 판단을 건너뜁니다. 가상 체결은 시장 가격의 근사치로, 실거래 성과를 뜻하지 않습니다.

## 1. 화면 확인

```powershell
npm install
npm run dev
```

- `http://localhost:3000/` 로그인 화면. 설정이 없으면 접근을 허용하지 않습니다.
- `http://localhost:3000/?preview=1` 공개 샘플 화면. 예시 데이터만 사용하고 모든 모델 변경은 비활성화합니다. 인증 우회 기능이 아닙니다.
- `npm test` 서버·실행기 테스트, `npm run build` Vercel용 정적 화면 생성.

## 2. Supabase 준비

1. 개인 Supabase 프로젝트를 만들고 Vercel에 연결합니다. 연결 직후 Vercel Production 환경 변수 중 웹에 필요한 값은 `SUPABASE_URL`, `SUPABASE_ANON_KEY`뿐입니다. DB 접속 정보와 service-role 키는 PC의 Git 제외 파일에 보관하고 Vercel 웹 환경에서는 제거합니다.
2. DB 접속 정보가 담긴 로컬 환경 파일을 준비한 뒤 `npm run db:migrate`를 실행합니다. 기본 경로는 `.runtime/production.env`이며, 마이그레이션 적용 이력은 DB의 `app_internal.schema_migrations`에 기록됩니다. `DB_SSL_CA_PATH`에 Supabase DB 인증서 경로를 지정하면 인증서를 검증합니다. 인증서가 없을 때는 TLS 연결을 요구합니다. SQL Editor에서 두 파일을 순서대로 실행해도 됩니다.
3. Authentication에서 이메일/비밀번호 사용자 **본인 한 명**을 만들고 이메일 확인을 완료합니다. `Allow new users to sign up`은 끕니다. TOTP MFA는 활성 상태로 유지합니다.
4. 사용자의 UUID를 확인한 뒤 SQL Editor에서 직접 아래 쿼리를 실행합니다. 웹 요청으로 소유자를 등록하는 경로는 없습니다.

```sql
insert into public.app_owner(singleton,user_id)
values(true,'YOUR_AUTH_USER_UUID');
```

5. `.env.example`을 `.env.local`로 복사하고 Supabase URL, 공개 키, `OWNER_USER_ID`를 입력합니다. SQL의 UUID와 반드시 같아야 합니다.
6. 로그인 후 인증 앱에 화면의 TOTP 설정 키를 등록하고 6자리 코드로 인증합니다. 서버와 RLS 모두 MFA가 없는 세션을 거부합니다.

기기 분실 시 Supabase 대시보드에서 본인 사용자 MFA factor를 초기화한 뒤 재등록합니다. 이 구현은 **본인 계정 + MFA**이며 특정 휴대폰 한 대에만 하드웨어적으로 묶인 인증은 아닙니다. 세션은 로그아웃으로 종료할 수 있습니다. 비밀번호/계정 복구는 Supabase 관리 화면에서 처리합니다.

## 3. Vercel 배포

저장소 루트를 Vercel 프로젝트로 연결합니다. `vercel.json`이 정적 화면과 서버리스 `/api` 함수를 구성합니다.

Vercel 환경 변수:

| 변수 | 값 |
|---|---|
| `SUPABASE_URL` | 프로젝트 URL |
| `SUPABASE_ANON_KEY` | 공개/publishable 키 |
| `OWNER_USER_ID` | 본인 Auth UUID |
| `APP_ORIGIN` | 실제 접속 주소, 예: `https://your-app.vercel.app` (끝 `/` 없이) |

**Vercel에 service-role 키, Codex 인증 파일, 증권사 키를 넣지 않습니다.** 웹 서버는 사용자의 세션 토큰으로 RLS가 적용된 요청만 보냅니다. 미리보기 배포에서 로그인까지 시험하려면 해당 배포의 정확한 origin을 지정해야 합니다.

## 4. PC 실행기

1. Codex CLI를 설치하고 이 PC의 터미널에서 `codex login`으로 ChatGPT 계정에 로그인합니다. `codex login status`로 확인합니다. IDE 세션과 CLI 로그인 상태는 다를 수 있습니다.
2. `.env.worker.example`을 `.env.worker.local`로 복사합니다. Supabase URL과 서버 전용 service-role 키, `WORKER_ID`, 한국투자증권 앱 키, Alpaca market data 키를 설정합니다. 비밀 키는 PC에만 저장합니다.
3. Windows는 `CODEX_JS_PATH`에 설치된 `@openai/codex/bin/codex.js`의 절대 경로를 지정합니다. Unix는 기본 `codex` 실행 파일을 사용하거나 `CODEX_BIN`을 지정할 수 있습니다. 셸 문자열로 명령을 조합하지 않습니다.
4. **터미널 두 개**에서 `npm run worker`, `npm run market`을 실행합니다. PC는 로그인된 Codex 계정의 모델 목록과 사용 한도를 읽습니다. CLI 인증과 시세 키를 클라우드에 전송하지 않습니다.
5. 대시보드에서 모델 목록 수신을 확인하고 필요한 작업을 활성화합니다. 초기 작업은 모두 중지 상태입니다.

실행기는 60초마다 계정 정보를, 기본 10초마다 설정/작업 기록을 동기화합니다. 계정 조회 중에는 한 번의 동기화가 더 오래 걸릴 수 있습니다. 네트워크 장애 시 UI에는 마지막 수신 시각이 남습니다. 설정의 `PC 수신 완료`는 다음 작업에 사용할 설정을 받았다는 뜻이며, 이미 실행했다는 뜻이 아닙니다.

시세 수집기는 PC에서만 실행합니다. 첫 가상 잔고는 각 국내 그룹 1,000만 원, 미국 그룹 1만 달러입니다. `PAPER_FEE_RATE`, `PAPER_SLIPPAGE`는 실제 증권사 비용이 아니라 실험 가정이며, 종목 변경·초기 잔고 변경·비용 변경은 비교 조건을 바꿉니다. `.runtime/paper-state.json`을 백업해 실험 기록을 보존하세요. 40종목 전부 최신 시세가 있는 구간만 새 AI 판단을 생성합니다. 미국 IEX에서 일부 종목의 체결이 드물면 해당 구간은 건너뛸 수 있습니다.

## 5. 작업 입력 계약

아래 형식으로 **현재 시점의 실제 데이터**를 담은 JSON 파일을 만들고 등록합니다. 날짜 예시는 만료되므로 현재 시각으로 수정해야 합니다. `snapshot`은 A/B에 공통으로 전달하며 A 전용 정보는 반드시 `feedback`에 둡니다.

```json
{
  "id": "kr-unique-job-id",
  "task_key": "kr_trade",
  "expires_at": "2026-11-02T01:07:00Z",
  "snapshot": {
    "as_of": "2026-11-02T01:05:00Z",
    "symbols": ["005930"],
    "data": [{"symbol":"005930","bars":[],"quote":null}]
  },
  "portfolios": {
    "A": {"cash":10000000,"positions":[]},
    "B": {"cash":10000000,"positions":[]}
  },
  "feedback": []
}
```

```powershell
npm run worker -- enqueue C:/path/to/job.json
```

`kr_trade`/`us_trade`는 A/B를 한 설정으로 묶어 실행합니다. `kr_feedback`/`us_feedback`는 `history`와 `feedback`으로 복기하며 주문 제안은 금지합니다. 중복 ID와 만료된 입력은 거부합니다. 중지된 작업은 대기하다 유효시간이 지나면 보관됩니다.

- `.runtime/results/<run-id>/input.txt`: 해당 실행에 실제 전달한 입력.
- `decision.json`: Codex 원본 결과.
- `validated-proposal.json`: 형식·종목·비중·유효시간 검사를 통과한 제안. 시세 수집기가 A/B 결과를 모아 다음 새 시세에서 가상 체결합니다.
- `run.json`: 모델, 설정 버전, 실행 상태와 토큰.
- `.runtime/outbox`: 클라우드 전송 대기 기록. 실행 UUID로 upsert하여 중복 합산을 방지합니다.

실행기 종료 시 진행 중 작업이 끝난 뒤 멈춥니다. 강제 종료된 작업은 다음 시작에 실패로 기록하며 자동 재실행하지 않습니다. 토큰을 회수하지 못한 작업은 `미수집`으로 남습니다.

첫 버전은 공정한 A/B 입력을 위해 쉘·브라우저·앱·플러그인·멀티에이전트 도구를 끄고 제공된 데이터만 판단하게 합니다. 도구를 추가하려면 데이터 접근 범위를 별도로 제한해야 합니다. CLI read-only sandbox 자체를 파일 읽기 격리로 간주하지 마세요. 별도의 OS 계정/컨테이너가 필요하면 `WORKER_ROOT`와 인증 환경을 그 계정에 구성합니다.

## 검증 및 운영 제한

- 실행 모델은 매 작업에 `-m`, 추론 수준은 `model_reasoning_effort`로 명시합니다. 기본 속도/서비스 설정은 CLI 기본값을 따릅니다.
- 계정 전체 한도는 조회 시각을 표시합니다. 작업 토큰으로 남은 구독량을 환산하지 않습니다. 캐시·추론은 부분 항목입니다.
- 서버가 모델 목록을 돌려주더라도 실제 호출 권한/잔여량은 실행 시 달라질 수 있습니다. 실패를 다른 모델로 숨겨서 대체하지 않습니다.
- 모델/추론을 변경한 시점에는 실험 조건이 바뀝니다. 기록의 설정 버전으로 비교 구간을 분리하세요.
- 작업·감사 기록은 누적됩니다. Supabase 무료 용량을 장기 유지하려면 보관 정책을 추가해야 합니다.
- 실제 클라우드 배포, Auth/MFA 통신, 실제 Codex 추론은 본인 계정 설정 후 확인해야 합니다. 로컬 fixture 테스트는 실계정 성공을 의미하지 않습니다.
- 미국·국내 공급자 인증과 응답률, API 호출 제한은 계정 연결 후 정규장에 확인해야 합니다. 별도 거래소 휴일 캘린더는 없고, 국내 정규장은 09:00~15:30 KST, 미국 정규장은 09:30~16:00 New York 기준으로 검사합니다. 가상 계좌는 배당·분할·환율·한국 거래세를 아직 반영하지 않습니다.

기존 Spring Boot 앱은 이 Node 실행기와 별도입니다. 추후 시장 수집/가상 체결 엔진을 Java에 구현하더라도 작업 JSON과 결과 계약을 그대로 사용할 수 있습니다.
