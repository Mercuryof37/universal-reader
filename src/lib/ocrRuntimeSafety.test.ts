import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * OCR 运行期的两个「静默杀手」设置。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这组断言对应的故障：进程直接消失，没有任何报错
 * ═══════════════════════════════════════════════════════════════
 *
 * 用户实测（应用自带诊断记录）：
 *   · 「刷新来源：不是应用发起的」—— 三条应用内刷新路径都没记录；
 *   · 轨迹走到 `recognize —— 第 1 页：开始识别`，画布只有 2500×3334（33MB，标准 A4）。
 *
 * 即：画布不大、渲染成功，**在第一次推理时进程就没了**。
 * 这类「不留异常、不留日志」的死亡只可能来自宿主层，而不是 JS 逻辑。
 * 两个最典型的来源就是下面这两项 —— 它们都不是异常，而是直接终止运行环境，
 * 所以**没有任何 try/catch 能拦住**，只能从配置上避免。
 */

const SRC = readFileSync(join(process.cwd(), 'src/lib/ocrEngine.ts'), 'utf8');

/**
 * 去掉注释后的源码。
 *
 * **必须去注释**：下面要断言「源码里不再出现 toBlob」，
 * 而解释「为什么不再用 toBlob」的那段注释里**本身就写着 toBlob**。
 * 不去注释就会匹配到注释、把正确的代码判成错的 ——
 * 这个坑在 `pwaOffline.test.ts` 和 `pwaReload.test.ts` 里已经各踩过一次，
 * 这是第三次，所以这次一开始就剥掉。
 */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

describe('ONNX 必须单线程运行', () => {
  it('显式设置 numThreads = 1', () => {
    /**
     * 多线程版 ONNX 需要 `SharedArrayBuffer`（要求页面跨源隔离 COOP/COEP）
     * 并且要**从脚本地址创建 Worker** —— 而我们的 wasm/worker 来自
     * cdn.jsdelivr.net，是**跨源**的，浏览器不允许跨源 new Worker。
     * 这两条任一失败，Emscripten 运行时会走 `abort()`：
     * 它不是 JS 异常，而是直接终止 —— 页面不会进 catch，只会消失。
     */
    expect(SRC).toMatch(/ort\.env\.wasm\.numThreads\s*=\s*1/);
  });

  it('设置的位置在文件顶部（早于任何推理调用）', () => {
    const set = SRC.indexOf('ort.env.wasm.numThreads');
    const firstUse = SRC.indexOf('new PaddleOcrService');
    expect(set).toBeGreaterThan(-1);
    expect(firstUse).toBeGreaterThan(-1);
    expect(set).toBeLessThan(firstUse);
  });
});

describe('不要把画布编码成 PNG 再送推理', () => {
  it('源码里不再出现 toBlob（那条路径会静默失败）', () => {
    /**
     * `toBlob` 是浏览器内部的异步编码：失败时既没有异常也没有回调，
     * 只能拿到 null；而在它内部崩溃时连 null 都拿不到 —— 进程直接消失。
     * 本库的 `recognize()` 本来就接受画布（`CanvasLike` 只要求
     * width/height/getContext('2d')），直接传画布即可，
     * 既少了全图编码，也少了这个静默失败点。
     */
    expect(CODE).not.toMatch(/toBlob/);
    expect(CODE).not.toMatch(/canvasToBuffer/);
  });

  it('确实把画布直接交给了 recognize', () => {
    expect(CODE).toMatch(/recognize\(canvas\b/);
  });

  it('仍然保留多档降采样的重试（画布过大时的兜底没有丢）', () => {
    // 降采样重试是另一条独立的健壮性措施，不应在本次改动中被顺手删掉
    expect(CODE).toMatch(/0\.7/);
    expect(CODE).toMatch(/0\.5/);
    expect(CODE).toMatch(/0\.35/);
  });
});
