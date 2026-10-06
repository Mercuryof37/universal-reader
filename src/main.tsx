/**
 * 应用入口。
 *
 * 做四件事：安装运行时兼容层、装配 chunk 加载失败的自愈、挂载 React、加载全局样式。
 * 兼容层必须是第一条 import —— 它要在任何库（尤其是 pdf.js）被调用前生效。
 */
import '@/lib/polyfills';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '@/App';
import '@/styles/index.css';
import { installPreloadErrorRecovery } from '@/lib/preloadRecovery';

// 必须在 React 挂载前装配：动态 import 失败可能发生在任何一次按需加载时，
// 而 vite:preloadError 事件只在 window 上抛一次，错过就没了。
installPreloadErrorRecovery();

const container = document.getElementById('root');
if (!container) throw new Error('找不到 #root 挂载点，index.html 可能被改动了。');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
