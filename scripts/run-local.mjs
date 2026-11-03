import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

for (const name of ['.env.pc.local', '.env.pc.worker.local'])
  if (!existsSync(name)) throw new Error(`${name}이 없습니다. 먼저 npm run setup:local을 실행하세요.`);

const root = process.cwd();
mkdirSync('.runtime', { recursive: true });
const log = createWriteStream(path.join(root, '.runtime', 'local-service.log'), { flags: 'a' });
const specs = [
  { name: 'web', envFile: '.env.pc.local', entry: 'scripts/serve-local.mjs' },
  { name: 'worker', envFile: '.env.pc.worker.local', entry: 'worker/main.mjs' },
  ...(process.argv.includes('--market') ? [{ name: 'market', envFile: '.env.pc.worker.local', entry: 'worker/market.mjs' }] : [])
];
const children = new Map();
const restarts = new Map();
let stopping = false;

function write(name, chunk) {
  const line = `[${new Date().toISOString()} ${name}] ${chunk}`;
  log.write(line);
  process.stdout.write(line);
}

function start(spec) {
  if (stopping) return;
  const child = spawn(process.execPath, [`--env-file-if-exists=${spec.envFile}`, spec.entry], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  children.set(spec.name, child);
  child.stdout.on('data', chunk => write(spec.name, chunk));
  child.stderr.on('data', chunk => write(spec.name, chunk));
  child.on('error', error => write(spec.name, `시작 실패: ${error.code ?? 'spawn'}\n`));
  child.on('close', code => {
    children.delete(spec.name);
    if (stopping) return;
    write(spec.name, `종료 코드 ${code}; 10초 뒤 재시작\n`);
    restarts.set(spec.name, setTimeout(() => start(spec), 10000));
  });
}

function stop() {
  if (stopping) return;
  stopping = true;
  for (const timer of restarts.values()) clearTimeout(timer);
  for (const child of children.values()) child.kill('SIGTERM');
  const timeout = setTimeout(() => process.exit(1), 15000);
  timeout.unref();
  const check = setInterval(() => {
    if (children.size) return;
    clearInterval(check);
    log.end(() => process.exit(0));
  }, 100);
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const spec of specs) start(spec);
