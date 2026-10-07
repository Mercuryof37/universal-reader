import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 「识别期间推迟刷新」这条防线。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这组断言对应的用户故障
 * ═══════════════════════════════════════════════════════════════
 *
 * 「能正常扫描，但扫描完看不到文档，识别框下方也没有创建新的项目」——
 * 而且**完全没有报错**。
 *
 * 真因之一是：`autoUpdate` 的 Service Worker 在新版本接管时会直接
 * `window.location.reload()`，而导入/OCR 的结果当时只存在内存里。
 *
 * 修法是给 `useRegisterSW` 传 `onNeedReload`，在**真的要刷新之前**
 * 先看有没有正在进行的导入/OCR。这里的顺序就是修复的全部 ——
 * 一旦有人重构时把 `importing` 判断挪到 `reload()` 之后，
 * 故障会**原样复现**，而类型检查、构建、其他测试都不会有任何反应。
 * 所以顺序必须被钉住。
 *
 * 注意：`pwa.ts` 顶层 import 了 `virtual:pwa-register/react`，
 * 那是 Vite 的虚拟模块，vitest 解析不了 —— 因此这里**读源码**断言，
 * 而不是 import 它。
 */

const PWA_SRC = readFileSync(join(process.cwd(), 'src/lib/pwa.ts'), 'utf8');
const PROMPT_SRC = readFileSync(join(process.cwd(), 'src/components/PwaPrompt.tsx'), 'utf8');

/**
 * 去掉注释后的 `pwa.ts`。
 *
 * **必须去注释**：上面那段解释「不传 onNeedReload 就会 reload」的文档注释里，
 * 本身就写着 `window.location.reload()`。不去注释的话，下面那些「谁在谁之前」
 * 的断言会匹配到注释里的字符串，从而得出错误结论 ——
 * 这个坑在 `pwaOffline.test.ts` 里已经踩过一次，这里不再踩第二次。
 */
const PWA_CODE = PWA_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

describe('刷新前必须先检查「是否有工作在进行」', () => {
  it('给 useRegisterSW 传了 onNeedReload —— 不传就退回无预警重载', () => {
    expect(PWA_SRC).toMatch(/onNeedReload\s*\(/);
  });

  it('onNeedReload 里读的是 libraryStore 的状态', () => {
    expect(PWA_CODE).toMatch(/useLibraryStore\.getState\(\)/);
    expect(PWA_CODE).toMatch(/state\.importing/);
  });

  it('两种「有活儿在内存里」的状态都要拦住刷新', () => {
    /**
     * 只判断 `importing` 是不够的 —— 用户看到的「仍然会自动刷新」正出在这里：
     * 扫描件导入后、还没点「开始识别」时，`importing` 是 **false**，
     * 但那份 PDF 的 buffer 只在内存里，刷新即丢失，用户得重新导入。
     * 所以 `scannedPdfPending` 也必须算作「忙」。
     */
    expect(PWA_CODE).toMatch(/state\.scannedPdfPending/);
    expect(PWA_CODE).toMatch(/const busy\s*=\s*state\.importing\s*\|\|\s*state\.scannedPdfPending/);
  });

  it('busy 的判断出现在 window.location.reload() **之前**', () => {
    const hook = PWA_CODE.indexOf('onNeedReload');
    expect(hook, 'pwa.ts 里找不到 onNeedReload').toBeGreaterThan(-1);

    const body = PWA_CODE.slice(hook);
    const guard = body.indexOf('const busy');
    const reload = body.indexOf('window.location.reload()');

    expect(guard, 'onNeedReload 里没有计算 busy').toBeGreaterThan(-1);
    expect(reload, 'onNeedReload 里没有兜底的 reload').toBeGreaterThan(-1);
    expect(guard, 'busy 判断必须在 reload 之前，否则修复失效').toBeLessThan(reload);
  });

  it('被推迟时置 updatePending，而不是静默什么都不做', () => {
    const body = PWA_CODE.slice(PWA_CODE.indexOf('onNeedReload'));
    const guard = body.indexOf('const busy');
    const setPending = body.indexOf('setUpdatePending(true)');
    const reload = body.indexOf('window.location.reload()');

    expect(setPending).toBeGreaterThan(-1);
    // 顺序：先判断 →（忙）置标志并 return →（闲）才 reload
    expect(guard).toBeLessThan(setPending);
    expect(setPending).toBeLessThan(reload);
  });

  it('PwaState 暴露 updatePending 与 reloadNow（界面需要它们）', () => {
    expect(PWA_SRC).toMatch(/updatePending:\s*boolean/);
    expect(PWA_SRC).toMatch(/reloadNow:\s*\(\)\s*=>\s*void/);
  });
});

describe('工作结束后自动刷新（否则新版本可能永远不生效）', () => {
  it('PwaPrompt 在手头活儿结束且在线时调用 reloadNow', () => {
    // busy = importing || scannedPdfPending（与 pwa.ts 的判据保持一致）
    expect(PROMPT_SRC).toMatch(/const busy\s*=\s*importing\s*\|\|\s*scannedPdfPending/);
    expect(PROMPT_SRC).toMatch(/updatePending\s*&&\s*!busy\s*&&\s*online/);
    expect(PROMPT_SRC).toMatch(/reloadNow\(\)/);
  });

  it('离线时不自动刷新 —— 此时界面显示的是「已离线」，重载只会莫名其妙', () => {
    /**
     * 这是一个真实存在过的缺陷：自动刷新的 effect 原先只判断
     * `updatePending && !importing`，**没有判断是否在线**。
     * 于是「推迟期间断网，然后识别结束」会导致一次毫无意义的离线重载 ——
     * 而且用户此刻看到的是优先级更高的「已离线」提示条，
     * 根本不知道有更新在等着。
     */
    expect(PROMPT_SRC).toMatch(/updatePending\s*&&\s*!busy\s*&&\s*online/);
    // online 必须在依赖数组里，否则状态变化不会重新触发
    expect(PROMPT_SRC).toMatch(/\},\s*\[[^\]]*\bonline\b[^\]]*\]\)/);
  });

  it('推迟期间界面上有明确提示，而不是让用户以为卡住了', () => {
    // 文案必须同时说明「有新版本」和「什么时候会刷新」
    expect(PROMPT_SRC).toMatch(/新版本已就绪/);
    expect(PROMPT_SRC).toMatch(/完成后会自动刷新/);
    // 并且给用户一个自己动手的出口
    expect(PROMPT_SRC).toMatch(/立即刷新/);
  });

  it('注释里的优先级表与代码顺序一致（离线 → 刷新 → 可离线）', () => {
    /**
     * 注释与代码不一致是「下次改错」的温床：原先那张表只列了
     * 「离线中 / 首次可离线使用」两项，新增的「新版本已就绪」分支没有进表。
     * 代码里的三道 if 顺序即真实优先级，注释必须跟上。
     */
    const offline = PROMPT_SRC.indexOf('if (!online)');
    const pending = PROMPT_SRC.indexOf('if (updatePending)');
    const ready = PROMPT_SRC.indexOf('if (offlineReady)');

    expect(offline).toBeGreaterThan(-1);
    expect(pending).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(-1);
    expect(offline).toBeLessThan(pending);
    expect(pending).toBeLessThan(ready);

    // 注释表格里三项都要出现
    expect(PROMPT_SRC).toMatch(/离线中/);
    expect(PROMPT_SRC).toMatch(/新版本就绪、刷新被推迟/);
    expect(PROMPT_SRC).toMatch(/首次可离线使用/);
  });
});
