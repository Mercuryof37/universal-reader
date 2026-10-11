import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { useSettingsStore } from '@/store/settingsStore';
import { recognizeFormula } from '@/services/formulaOcrService';

/**
 * 公式识别的「上传开关」。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这条断言守的是一个对外承诺
 * ═══════════════════════════════════════════════════════════════
 *
 * 本应用对外的核心承诺是「文档全程留在本机浏览器，不上传服务器」。
 * 但 `5184bde` 引入的 SimpleTex 公式增强会把页面上裁剪出的公式区域
 * （一小块 PNG）POST 到自建 Worker，再由 Worker 转发给第三方
 * `server.simpletex.cn`。
 *
 * ⚠️ 这里原本写着「这是**整个应用里唯一**会把文档内容送出本机的路径」——
 * **那句话是错的**，而且错得有代价：另两条路径（云端翻译、云端语音）
 * 因此长期没有被按同一套标准审视，其中云端语音还是**默认开启**的
 * （旧的 `ttsPreference: 'auto'`）。三条路径的现状与清单见
 * `store/outboundPrivacy.test.ts` 与 `lib/outboundPaths.ts`。
 *
 * 公式这条路原本是**自动触发、无法关闭**的，一个自动且不可关闭的上传
 * 路径与那句承诺直接冲突。现在的做法是把它改成**显式选择加入**：
 * 默认 `false`，不打开就一个字节都不外发。
 *
 * 所以这里钉死两件事：
 * 1. 默认值必须是关闭（否则等于悄悄恢复了默认上传）；
 * 2. 引擎里的开关判断必须**早于**任何网络调用 —— 不能出现
 *    「先算完公式候选、甚至已经发出请求，才想起检查开关」。
 */

const OCR_ENGINE_SRC = readFileSync(join(process.cwd(), 'src/lib/ocrEngine.ts'), 'utf8');

describe('公式识别上传开关的默认值', () => {
  it('默认关闭 —— 不显式打开就不外发任何内容', () => {
    expect(useSettingsStore.getState().formulaOcrEnabled).toBe(false);
  });

  it('用户可以打开（开关不是写死的）', () => {
    const before = useSettingsStore.getState().formulaOcrEnabled;

    useSettingsStore.getState().setFormulaOcrEnabled(true);
    expect(useSettingsStore.getState().formulaOcrEnabled).toBe(true);

    useSettingsStore.getState().setFormulaOcrEnabled(false);
    expect(useSettingsStore.getState().formulaOcrEnabled).toBe(false);

    // 复原，避免影响同一进程内的其他测试文件
    useSettingsStore.getState().setFormulaOcrEnabled(before);
  });
});

describe('开关在引擎里的位置（读源码断言顺序）', () => {
  it('enhanceFormulaRegions 会读取该设置', () => {
    expect(OCR_ENGINE_SRC).toMatch(/useSettingsStore\.getState\(\)\.formulaOcrEnabled/);
  });

  it('开关判断早于 detectFormulaRegions（不该先白算一遍候选区域）', () => {
    const guard = OCR_ENGINE_SRC.indexOf('formulaOcrEnabled');
    const detect = OCR_ENGINE_SRC.indexOf('detectFormulaRegions(words)');

    expect(guard, 'ocrEngine.ts 里找不到开关判断').toBeGreaterThan(-1);
    expect(detect, 'ocrEngine.ts 里找不到 detectFormulaRegions(words) 调用').toBeGreaterThan(-1);
    expect(guard).toBeLessThan(detect);
  });

  it('开关判断早于真正的网络调用 recognizeFormula', () => {
    const guard = OCR_ENGINE_SRC.indexOf('formulaOcrEnabled');
    const network = OCR_ENGINE_SRC.indexOf('await recognizeFormula(');

    expect(network, 'ocrEngine.ts 里找不到 recognizeFormula 调用').toBeGreaterThan(-1);
    expect(guard).toBeLessThan(network);
  });

  it('关闭时是提前 return，而不是靠后续失败兜底', () => {
    // 注意：不能只按 'formulaOcrEnabled' 找行 —— 上面的文档注释里也提到了
    // `settingsStore.formulaOcrEnabled`，会先被匹配到。这里按真正的代码形态找。
    const line = OCR_ENGINE_SRC.split('\n').find((l) =>
      l.includes('getState().formulaOcrEnabled'),
    );
    expect(line).toBeDefined();
    expect(line).toMatch(/return words/);
  });
});

/**
 * 第二道防线：真正执行上传的那个函数自己也要拒绝。
 *
 * 只靠调用方自觉是不够的 —— 将来任何新调用方忘了检查开关，
 * 就会静默把文档内容发出去。所以 `recognizeFormula` 里也有一道判断。
 * 这组断言直接调用它，确认**在开关关闭时会抛错，而不是发出请求**。
 */
describe('formulaOcrService 的第二道防线', () => {
  it('开关关闭时拒绝执行（默认状态即如此）', async () => {
    expect(useSettingsStore.getState().formulaOcrEnabled).toBe(false);

    // 传入一个假的图像对象：因为开关检查在最前面，
    // 它不该走到任何需要真实 canvas 的代码，更不该发请求。
    await expect(
      recognizeFormula({} as unknown as HTMLCanvasElement),
    ).rejects.toThrow(/已拒绝上传|formulaOcrEnabled/);
  });

  it('服务源码里的开关检查早于构造请求体的代码', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/services/formulaOcrService.ts'),
      'utf8',
    );
    const guard = src.indexOf('formulaOcrEnabled');
    const toPng = src.indexOf('await toPngBuffer(');
    const post = src.indexOf('await fetch(');

    expect(guard, '找不到开关检查').toBeGreaterThan(-1);
    expect(toPng, '找不到 toPngBuffer 调用').toBeGreaterThan(-1);
    expect(post, '找不到 fetch 调用').toBeGreaterThan(-1);

    // 必须先检查开关，再去编码图片、再去发请求
    expect(guard).toBeLessThan(toPng);
    expect(guard).toBeLessThan(post);
  });
});
