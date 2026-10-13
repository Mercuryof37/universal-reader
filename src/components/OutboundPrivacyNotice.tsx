import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ShieldCheck, X } from 'lucide-react';
import { useSettingsStore } from '@/store/settingsStore';
import { listOutboundPaths } from '@/services/translationService';
import { EXCLUDED_DATA_SPECS } from '@/lib/outboundPaths';

/** Settings link and shared user-facing notice for data that may leave this device. */
export function OutboundPrivacyNoticeLink() {
  const [open, setOpen] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const formulaOcrEnabled = useSettingsStore((s) => s.formulaOcrEnabled);
  const cloudTranslationConsent = useSettingsStore((s) => s.cloudTranslationConsent);
  const ttsCloudConsent = useSettingsStore((s) => s.ttsCloudConsent);
  const ttsPreference = useSettingsStore((s) => s.ttsPreference);
  const paths = useMemo(
    () => listOutboundPaths(),
    [formulaOcrEnabled, cloudTranslationConsent, ttsCloudConsent, ttsPreference],
  );

  useEffect(() => {
    if (!open) return;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-left text-[11px] text-[var(--reader-accent)] underline underline-offset-2 hover:opacity-80"
      >
        查看数据处理须知
      </button>
      {open && createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="outbound-notice-title"
            className="max-h-[min(85vh,42rem)] w-full max-w-xl overflow-hidden rounded-xl border border-[var(--reader-border)] bg-[var(--reader-bg)] text-[var(--reader-fg)] shadow-2xl"
          >
            <header className="flex items-center justify-between gap-3 border-b border-[var(--reader-border)] p-4">
              <div>
                <h2 id="outbound-notice-title" className="text-base font-semibold">数据处理须知</h2>
                <p className="mt-1 text-xs text-[var(--reader-muted)]">请根据需要开启相关功能；授权开关可随时关闭。</p>
              </div>
              <button
                ref={closeButtonRef}
                type="button"
                onClick={() => setOpen(false)}
                aria-label="关闭数据处理须知"
                className="rounded-md p-1.5 hover:bg-[var(--reader-panel)]"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </header>

            <div className="max-h-[calc(min(85vh,42rem)-8rem)] overflow-y-auto p-4 text-sm">
              <h3 className="mb-2 font-semibold">可能发送到相关服务的内容</h3>
              <ul className="mb-5 flex flex-col gap-2">
                {paths.map((path) => (
                  <li key={path.key} className="rounded-lg border border-[var(--reader-border)] p-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium">{path.title}</span>
                      <span className={path.enabled ? 'shrink-0 text-xs text-amber-700 dark:text-amber-300' : 'shrink-0 text-xs text-[var(--reader-muted)]'}>
                        {path.enabled ? '已开启' : '未开启'}
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-[var(--reader-muted)]">
                      {noticeDetails[path.key]}
                      {!path.capable && ' 当前版本未配置该服务。'}
                    </p>
                  </li>
                ))}
                <li className="rounded-lg border border-[var(--reader-border)] p-3 text-xs leading-relaxed text-[var(--reader-muted)]">
                  使用上述云服务时，服务方还会收到连接所需的信息，例如 IP 地址。
                </li>
              </ul>

              <h3 className="mb-2 flex items-center gap-1.5 font-semibold">
                <ShieldCheck className="h-4 w-4 text-emerald-600" aria-hidden />
                不会发送的内容
              </h3>
              <p className="mb-2 text-xs text-[var(--reader-muted)]">以下内容保留在本机：</p>
              <ul className="flex flex-col gap-1.5">
                {EXCLUDED_DATA_SPECS.map((item) => (
                  <li key={item.key} className="rounded-md bg-[var(--reader-panel)] px-3 py-2 text-xs font-semibold leading-relaxed">
                    {item.title}
                  </li>
                ))}
              </ul>
            </div>

            <footer className="flex justify-end border-t border-[var(--reader-border)] p-3">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg bg-[var(--reader-accent)] px-4 py-2 text-xs font-medium text-[var(--reader-bg)] hover:opacity-90"
              >
                我知道了
              </button>
            </footer>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}

const noticeDetails = {
  formulaOcrEnabled: '开启公式增强时，会发送页面中裁剪出的公式图像给 SimpleTex 识别。',
  cloudTranslationConsent: '开启云端翻译时，会发送正在阅读的段落；手动选中并查译时，只发送所选文字。服务由 DeepL 或 OpenAI 提供。',
  ttsCloudConsent: '选择并允许云端朗读时，会发送正在朗读的段落和所选音色信息给 Azure 语音服务。',
} as const;
