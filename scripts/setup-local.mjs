import { randomBytes, randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { openLocalStore } from '../lib/local-store.mjs';
import { makePasswordHash } from '../local/auth.mjs';

const email = process.argv[2]?.trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email ?? ''))
  throw new Error('사용법: npm run setup:local -- 본인이메일');

async function exists(file) { return access(file).then(() => true, () => false); }
for (const file of ['.env.pc.local', '.env.pc.worker.local'])
  if (await exists(file)) throw new Error(`${file}이 이미 있습니다. 기존 설정을 덮어쓰지 않습니다.`);

function secretPrompt(label) {
  return new Promise((resolve, reject) => {
    const input = process.stdin, output = process.stdout;
    if (!input.isTTY || !input.setRawMode) return reject(new Error('비밀번호 입력은 대화형 터미널에서 실행하세요.'));
    let value = '';
    const priorRaw = input.isRaw;
    output.write(label);
    input.setRawMode(true);
    input.resume();
    const finish = (error) => {
      input.off('data', onData);
      input.setRawMode(priorRaw);
      input.pause();
      output.write('\n');
      error ? reject(error) : resolve(value);
    };
    const onData = chunk => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u0003') return finish(new Error('설정이 취소되었습니다.'));
        if (char === '\u007f' || char === '\b') {
          if (value) { value = value.slice(0, -1); output.write('\b \b'); }
        } else if (char >= ' ') { value += char; output.write('*'); }
      }
    };
    input.on('data', onData);
  });
}

const store = await openLocalStore();
try {
  const count = await store.run(db => db.query('select count(*)::int as count from app_owner'));
  if (count.rows[0].count) throw new Error('이미 로컬 소유자가 설정되어 있습니다.');
  const password = await secretPrompt('새 로컬 로그인 비밀번호(12자 이상): ');
  const confirmation = await secretPrompt('비밀번호 다시 입력: ');
  if (password !== confirmation) throw new Error('두 비밀번호가 일치하지 않습니다.');
  const { salt, hash } = await makePasswordHash(password);
  const workerToken = randomBytes(32).toString('base64url');
  const appEnv = [
    'LOCAL_DATA_DIR=.runtime/local',
    'APP_ORIGIN=http://localhost:3000',
    'PORT=3000',
    `LOCAL_WORKER_TOKEN=${workerToken}`
  ].join('\n') + '\n';
  const workerEnv = [
    'LOCAL_CONTROL_URL=http://127.0.0.1:3000',
    `LOCAL_WORKER_TOKEN=${workerToken}`,
    'WORKER_ROOT=.runtime/local-worker',
    'WORKER_ID=home-pc'
  ].join('\n') + '\n';
  await writeFile('.env.pc.local', appEnv, { flag: 'wx', mode: 0o600 });
  await writeFile('.env.pc.worker.local', workerEnv, { flag: 'wx', mode: 0o600 });
  await store.run(db => db.query(`insert into app_owner(singleton,user_id,email,password_salt,password_hash)
    values(true,$1,$2,$3,$4)`, [randomUUID(), email, salt, hash]));
  console.log('로컬 소유자와 PC 전용 설정을 만들었습니다. 인증 앱 등록은 첫 로그인에서 진행합니다.');
} finally {
  await store.close();
}
