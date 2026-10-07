/**
 * 应用入口。
 *
 * 做五件事：安装运行时兼容层、装配 chunk 加载失败的自愈、统计页面加载次数、
 * 挂载 React、加载全局样式。
 * 兼容层必须是第一条 import —— 它要在任何库（尤其是 pdf.js）被调用前生效。
 */
import '@/lib/polyfills';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '@/App';
import '@/styles/index.css';
import { installPreloadErrorRecovery } from '@/lib/preloadRecovery';
import { bumpReloadCount, noteOcrCrashIfInterrupted } from '@/lib/sessionDiagnostics';

// 必须在 React 挂载前装配：动态 import 失败可能发生在任何一次按需加载时，
// 而 vite:preloadError 事件只在 window 上抛一次，错过就没了。
installPreloadErrorRecovery();

// 统计本会话的页面加载次数。放在最前面，保证计到的是真实加载次数；
// 界面会据此显示「本页已自动刷新 N 次」—— 用户打不开控制台时，
// 这是判断「页面是不是在被反复重载」的唯一手段。
bumpReloadCount();

// 若上一次识别是被外部中断的，把它**持久**记下来（localStorage）。
// 必须在这里做：那次的记录只在 sessionStorage 里，关掉标签页就没了，
// 而用户下次很可能是新开标签页 —— 那就再也无从知道这台机器上它崩过。
noteOcrCrashIfInterrupted();

const container = document.getElementById('root');
if (!container) throw new Error('找不到 #root 挂载点，index.html 可能被改动了。');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
