/**
 * Worker 端点的端到端检查（Node 的 fetch，不依赖 PowerShell 的错误流处理）。
 *
 * 起因：用 PowerShell 的 Invoke-WebRequest 测试时，所有 4xx/5xx 响应的正文
 * 都读成空字符串，一度让人以为 Worker 返回了空响应。
 * Node 的 fetch 对错误响应同样如实读取 body，用它才能得到真相。
 *
 * 用法：
 *   node scripts/probe-worker.mjs                        # 测已部署的 Worker
 *   node scripts/probe-worker.mjs http://localhost:8787  # 测本地 wrangler dev
 */

const base = (process.argv[2] ?? 'https://universal-reader-api.616444703.workers.dev').replace(
  /\/$/,
  '',
);

const ORIGIN = 'https://universal-reader.pages.dev';

/** 期望返回"带正文的错误响应"、且不依赖外部 API 的用例 */
const CASES = [
  { name: '缺字段 → 期望 400', path: '/api/translate', body: {}, expect: 400 },
  {
    name: '未知端点 → 期望 404',
    path: '/api/nope',
    body: { text: 'a', targetLang: 'zh' },
    expect: 404,
  },
  {
    name: '单次超长 → 期望 413',
    path: '/api/translate',
    body: { text: 'a'.repeat(4001), targetLang: 'zh' },
    expect: 413,
  },
];

console.log(`探测目标：${base}\n`);

let failures = 0;

for (const c of CASES) {
  try {
    const resp = await fetch(base + c.path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify(c.body),
    });
    const text = await resp.text();
    const statusOk = resp.status === c.expect;
    const bodyOk = text.length > 0;

    console.log(`${c.name}`);
    console.log(`  状态：HTTP ${resp.status}${statusOk ? '' : `（期望 ${c.expect}）`}`);
    console.log(`  正文：${bodyOk ? text.slice(0, 160) : '（空）'}`);
    console.log(`  CORS：${resp.headers.get('access-control-allow-origin') ?? '（无）'}`);

    if (!statusOk || !bodyOk) {
      failures++;
      console.log('  ⚠ 不符合预期');
    }
    console.log('');
  } catch (err) {
    failures++;
    console.log(`${c.name}\n  请求失败：${err.message}\n`);
  }
}

console.log(failures === 0 ? '全部通过' : `${failures} 项不符合预期`);
process.exitCode = failures === 0 ? 0 : 1;
