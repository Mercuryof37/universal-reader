import { useEffect } from 'react';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { DocumentLibrary } from '@/components/DocumentLibrary';
import { ReaderView } from '@/components/ReaderView';
import { PwaPrompt } from '@/components/PwaPrompt';

/**
 * 应用根组件。
 *
 * 只用"有没有打开文档"这一个条件切换视图，不引入路由库：
 * 一个本地阅读器没有分享链接、没有深链、没有服务端渲染的需求，
 * 为此引入 react-router 只会增加体积和一层心智负担。
 *
 * PWA 提示条挂在这里而不是各视图内部：更新提示与在线/离线状态
 * 对整个应用成立，放在视图里会导致切换文档时提示条重建。
 */
export default function App() {
  const currentDoc = useLibraryStore((s) => s.currentDoc);
  const init = useLibraryStore((s) => s.init);
  const theme = useSettingsStore((s) => s.theme);

  // 启动时把 IndexedDB 里的文档索引读进内存
  useEffect(() => {
    void init();
  }, [init]);

  // 主题令牌同步；data-theme 挂在最外层容器上，弹层与侧栏都能继承变量
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <div className="h-full" data-theme={theme}>
      {currentDoc ? <ReaderView /> : <DocumentLibrary />}
      <PwaPrompt />
    </div>
  );
}
