# 다른 PC에 설치하기

이 구성은 **배포 PC 한 대**에서 웹 화면, API, 로컬 데이터베이스, Codex 작업 실행기와 시세 수집기를 실행합니다. 이 저장소를 수정한 개발 PC에서는 서비스를 실행할 필요가 없습니다. 모바일은 Tailscale에 로그인해 배포 PC의 HTTPS 주소에 접속합니다. 증권사 실주문 기능은 없습니다.

## 준비물

- 배포 PC에 Node.js 22 이상, Git, Codex CLI, Tailscale을 설치합니다. Windows 기준으로 아래 명령을 설명합니다.
- 휴대폰에도 Tailscale을 설치하고 같은 tailnet에 로그인합니다. 배포 PC를 절전 상태로 두지 않아야 밖에서도 접속됩니다.
- 국내/미국 자동 시세 수집을 사용하려면 한국투자증권 시세 API와 Alpaca Market Data 키를 배포 PC에서 준비합니다. 키가 없으면 화면·설정·작업 실행기만 시작할 수 있습니다.

## 1. 코드와 로컬 계정

```powershell
git clone --branch pc-only https://github.com/vattis/ai-invest.git
cd ai-invest
npm ci --omit=dev
npm install -g @openai/codex
codex login
codex login status
npm run setup:local -- andrew0726@naver.com
```

설정 명령은 새 로그인 비밀번호(12자 이상)를 터미널에서 두 번 입력받습니다. 이 비밀번호는 기존 Supabase 비밀번호와 별도이며, 설정 결과는 Git에서 제외된 `.env.pc.local`, `.env.pc.worker.local`, `.runtime/local/db`에 저장됩니다. 첫 로그인에서 휴대폰 인증 앱에 TOTP 키를 등록합니다. 초기 네 작업은 모두 비활성 상태입니다.

Windows에서는 `.env.pc.worker.local`에 Codex JavaScript 실행 경로를 한 줄 추가합니다. `npm root -g`의 출력 아래에 실제 파일이 있는지 확인하세요.

```powershell
$codexJs = Join-Path (npm root -g) '@openai/codex/bin/codex.js'
if (-not (Test-Path $codexJs)) { throw "Codex CLI 파일을 찾을 수 없습니다: $codexJs" }
Add-Content .env.pc.worker.local "CODEX_JS_PATH=$($codexJs.Replace('\','/'))"
```

## 2. 로컬 화면과 모바일 접속

먼저 배포 PC에서 `npm run start:local`을 실행하고 `http://127.0.0.1:3000`을 엽니다. 로그인과 TOTP 등록, 대시보드 표시를 확인합니다. 이 명령은 화면/API와 Codex 작업 실행기를 함께 시작합니다. 종료는 `Ctrl+C`입니다.

배포 PC에서 Tailscale에 로그인한 뒤 아래 명령으로 **Serve**를 설정합니다. 출력된 HTTPS 주소를 확인합니다. Tailscale이 HTTPS 활성화를 요청하면 해당 절차를 완료합니다. `funnel`은 사용하지 않습니다.

```powershell
tailscale serve --bg 3000
tailscale serve status
```

`.env.pc.local`의 `APP_ORIGIN=http://localhost:3000`을 출력된 정확한 주소(예: `APP_ORIGIN=https://my-pc.example.ts.net`, 끝 `/` 없음)로 바꾼 뒤 서버를 다시 시작합니다. 휴대폰 Tailscale 연결을 켜고 그 HTTPS 주소로 로그인합니다. Tailscale Serve는 tailnet에만 공개하고 HTTPS를 제공합니다. 앱 서버 자체는 `127.0.0.1`에만 바인딩합니다.

## 3. 시세 수집과 자동 시작

`.env.pc.worker.local`에 발급받은 키를 직접 추가합니다. 이 파일은 Git에 올리지 않습니다.

```dotenv
KIS_APP_KEY=발급받은_키
KIS_APP_SECRET=발급받은_비밀키
ALPACA_KEY_ID=발급받은_키
ALPACA_SECRET_KEY=발급받은_비밀키
```

시세 수집까지 시작하려면 `npm run start:local -- --market`을 실행합니다. 키가 없으면 `--market` 없이 시작합니다. 시세 수집기는 국내 20개, 미국 20개 종목의 새 시세가 모두 있는 구간에만 AI 작업을 생성합니다. Codex CLI의 로그인 상태와 계정 모델 목록이 대시보드에 나타나면 각 작업을 활성화할 수 있습니다.

Windows 로그인 시 자동 시작하려면 **배포 PC에서만** 다음을 실행합니다. 작업은 해당 Windows 사용자의 로그인 세션에서 실행되므로 재부팅 뒤에도 그 사용자로 로그인해야 합니다.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-windows-task.ps1 -Market
Start-ScheduledTask AIInvestLocal
Get-ScheduledTask AIInvestLocal
```

키가 없으면 설치 명령에서 `-Market`을 빼세요. 수동 실행 중이었다면 `Ctrl+C`로 먼저 종료하세요. 실행 로그는 `.runtime/local-service.log`에 기록됩니다. 자동 실행을 중지하려면 `Stop-ScheduledTask AIInvestLocal`; 자동 시작을 해제하려면 `Disable-ScheduledTask AIInvestLocal`을 사용합니다. Windows 이외의 PC에서는 `npm run start:local -- --market`을 사용자 서비스 관리자로 실행합니다.

## 데이터와 이전 클라우드 구성

로컬 데이터는 `.runtime/local`(계정·설정·토큰·거래 기록)과 `.runtime/local-worker`(작업 큐·결과·가상 계좌 상태)에 있습니다. 두 디렉터리와 `.env.pc.local`, `.env.pc.worker.local`을 **함께** 안전한 위치에 백업하세요. 백업 전 서비스를 중지하고 완료 후 다시 시작해야 일관된 복사본을 얻습니다. 파일에는 로그인 인증 정보, 시세 API 키 또는 작업 입력이 포함될 수 있습니다. 두 환경 파일의 `LOCAL_WORKER_TOKEN`은 같아야 합니다.

기존 Vercel과 Supabase 구성은 별도로 남아 있습니다. 배포 PC 검증 전에는 Vercel 프로젝트, Supabase 프로젝트, 가비아 DNS를 변경하지 마세요. `invest.vatti.site`는 현 시점의 기존 클라우드 배포 주소이고, PC 단독 구성의 모바일 주소는 Tailscale이 출력한 `*.ts.net` URL입니다. 새 PC에서의 가동을 확인한 다음 기존 클라우드 배포를 정리하면 됩니다. 현재 클라우드의 모의거래 기록은 이 로컬 DB로 자동 이전하지 않습니다.
