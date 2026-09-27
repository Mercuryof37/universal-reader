/**
 * 应用入口。
 *
 * 只做三件事：安装运行时兼容层、挂载 React、加载全局样式。
 * 兼容层必须是第一条 import —— 它要在任何库（尤其是 pdf.js）被调用前生效。
 * 主题令牌的同步放在 App 里（那里才知道当前主题），入口文件保持"没有业务逻辑"。
 */
import '@/lib/polyfills';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '@/App';
import '@/styles/index.css';

const container = document.getElementById('root');
if (!container) throw new Error('找不到 #root 挂载点，index.html 可能被改动了。');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
