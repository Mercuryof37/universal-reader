import { describe, expect, it } from 'vitest';
import { isOriginAllowed } from '../../worker/api-proxy';

/**
 * CORS 来源白名单的测试。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么这个函数值得单独测
 * ═══════════════════════════════════════════════════════════════
 *
 * 它是 Worker 里唯一有分支逻辑的安全判定，而**两种出错方式都很隐蔽**：
 *
 * | 出错方向 | 后果 | 何时被发现 |
 * |---|---|---|
 * | 放行了不该放行的来源 | **别人白嫖你的付费 API 额度** | 收到账单时 |
 * | 挡住了本该放行的来源 | 云端翻译静默失效 | 用户抱怨"翻译没反应"时 |
 *
 * 两者都不会立刻报错，因此必须靠测试锁死。
 *
 * 真实背景：只支持单一来源在实际使用中不够 ——
 * Cloudflare Pages **每次推送都生成新的预览地址**（哈希会变），
 * 只填生产地址则预览不可用，只填预览地址则生产不可用且下次推送后再次失效。
 */

const PROD = 'https://universal-reader.pages.dev';
const PREVIEW = 'https://1955a0bc.universal-reader.pages.dev';

describe('isOriginAllowed：基本匹配', () => {
  it('精确匹配单一来源', () => {
    expect(isOriginAllowed(PROD, PROD)).toBe(true);
    expect(isOriginAllowed(PREVIEW, PROD)).toBe(false);
  });

  it('未配置时一律拒绝（fail-closed）', () => {
    expect(isOriginAllowed(PROD, undefined)).toBe(false);
    expect(isOriginAllowed(PROD, '')).toBe(false);
    expect(isOriginAllowed(PROD, '   ')).toBe(false);
  });

  it('逗号分隔的多个来源都生效', () => {
    const config = `${PROD},${PREVIEW}`;
    expect(isOriginAllowed(PROD, config)).toBe(true);
    expect(isOriginAllowed(PREVIEW, config)).toBe(true);
    expect(isOriginAllowed('https://evil.example.com', config)).toBe(false);
  });

  it('忽略多余空格', () => {
    expect(isOriginAllowed(PROD, `  ${PROD} , ${PREVIEW}  `)).toBe(true);
  });
});

describe('isOriginAllowed：通配符', () => {
  const config = `${PROD},https://*.universal-reader.pages.dev`;

  it('通配符匹配任意预览哈希', () => {
    // 这是它的主要用途：Cloudflare Pages 每次推送生成新的哈希前缀，
    // 无法预先枚举，必须用通配符覆盖
    expect(isOriginAllowed(PREVIEW, config)).toBe(true);
    expect(isOriginAllowed('https://070cf45d.universal-reader.pages.dev', config)).toBe(true);
    expect(isOriginAllowed('https://deadbeef.universal-reader.pages.dev', config)).toBe(true);
  });

  it('通配符不覆盖生产地址 —— 生产地址需单独列出', () => {
    // `*` 只匹配单个 DNS 标签，所以它匹配不了"没有子域"的生产地址。
    // 这是刻意的收窄，见 globToRegExp 的注释。
    expect(isOriginAllowed(PROD, 'https://*.universal-reader.pages.dev')).toBe(false);
    // 因此生产环境必须在配置里单独写出来（config 里已有）
    expect(isOriginAllowed(PROD, config)).toBe(true);
  });

  it('通配符不跨越点号（避免匹配到更深的子域）', () => {
    // 这是刻意的收窄：[^.]+ 而不是 .+
    expect(isOriginAllowed('https://a.b.universal-reader.pages.dev', config)).toBe(false);
  });

  it('不匹配不同域名', () => {
    expect(isOriginAllowed('https://universal-reader.pages.dev.evil.com', config)).toBe(false);
    expect(isOriginAllowed('https://evil-universal-reader.pages.dev', config)).toBe(false);
  });
});

describe('isOriginAllowed：安全约束', () => {
  it('只含通配符的规则被忽略（否则白名单形同虚设）', () => {
    // 这些配置看起来"允许所有"，必须被拒绝 —— 否则 Worker 会变成公开代理
    for (const dangerous of ['*', 'https://*', 'http*', 'https://**']) {
      expect(isOriginAllowed(PROD, dangerous), `配置 "${dangerous}" 不应放行`).toBe(false);
      expect(
        isOriginAllowed('https://evil.example.com', dangerous),
        `配置 "${dangerous}" 不应放行任意来源`,
      ).toBe(false);
    }
  });

  it('危险规则与其他合法规则混用时，只放行合法的那条', () => {
    const config = `*,${PROD}`;
    expect(isOriginAllowed(PROD, config)).toBe(true);
    expect(isOriginAllowed('https://evil.example.com', config)).toBe(false);
  });

  it('点号按字面量匹配，不当通配符', () => {
    // 若把 . 当通配，https://universalXreader.pages.dev 就会被误放行
    expect(isOriginAllowed('https://universalXreader.pages.dev', PROD)).toBe(false);
  });

  it('协议必须一致', () => {
    expect(isOriginAllowed('http://universal-reader.pages.dev', PROD)).toBe(false);
  });

  it('端口号参与匹配', () => {
    expect(isOriginAllowed('http://localhost:5173', 'http://localhost:5173')).toBe(true);
    expect(isOriginAllowed('http://localhost:5173', 'http://localhost:5174')).toBe(false);
  });

  it('开发地址可以显式加入', () => {
    const config = `${PROD},http://localhost:5173`;
    expect(isOriginAllowed('http://localhost:5173', config)).toBe(true);
    expect(isOriginAllowed(PREVIEW, config)).toBe(false);
  });
});
