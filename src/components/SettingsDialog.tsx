import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import type { AppPaths } from "../types";

type Tab = "storage" | "about";

interface Props {
  onClose: () => void;
}

/**
 * Settings dialog with a sidebar layout.
 * - 存储管理: Shows full paths to all cache directories and database file.
 * - 关于: Shows app version and description.
 */
export function SettingsDialog({ onClose }: Props) {
  const [tab, setTab] = useState<Tab>("storage");
  const [paths, setPaths] = useState<AppPaths | null>(null);

  useEffect(() => {
    invoke<AppPaths>("get_app_paths")
      .then(setPaths)
      .catch((e) => console.error("get_app_paths:", e));
  }, []);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return createPortal(
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="settings-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* Sidebar */}
        <nav className="settings-sidebar">
          <div className="settings-sidebar-title">设置</div>
          <button
            className={`settings-sidebar-item ${tab === "storage" ? "active" : ""}`}
            onClick={() => setTab("storage")}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <ellipse cx="12" cy="5" rx="9" ry="3" />
              <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
            </svg>
            存储管理
          </button>
          <button
            className={`settings-sidebar-item ${tab === "about" ? "active" : ""}`}
            onClick={() => setTab("about")}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            关于
          </button>
        </nav>

        {/* Content */}
        <div className="settings-content">
          {tab === "storage" && (
            <>
              <h2 className="settings-content-title">存储管理</h2>
              <p className="settings-content-desc">
                应用数据和缓存的完整路径。
              </p>
              <div className="settings-path-list">
                {paths ? (
                  <>
                    <PathRow label="应用数据目录" path={paths.appDataDir} />
                    <PathRow label="数据库" path={paths.dbPath} />
                    <PathRow label="封面缩略图" path={paths.thumbnailsDir} />
                    <PathRow label="页面缓存" path={paths.pagesCacheDir} />
                  </>
                ) : (
                  <p className="settings-loading">加载中…</p>
                )}
              </div>
            </>
          )}

          {tab === "about" && (
            <>
              <h2 className="settings-content-title">关于</h2>
              <p className="settings-content-desc">
                Comic Reader — 高性能本地漫画阅读器
              </p>
              <div className="settings-about-info">
                <div className="settings-about-row">
                  <span className="settings-about-label">版本</span>
                  <span>1.0.0</span>
                </div>
                <div className="settings-about-row">
                  <span className="settings-about-label">技术栈</span>
                  <span>Tauri v2 · Rust · React · SQLite</span>
                </div>
                <div className="settings-about-row">
                  <span className="settings-about-label">支持格式</span>
                  <span>ZIP / CBZ</span>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** A single path row: label above, monospace path below with copy-on-click. */
function PathRow({ label, path }: { label: string; path: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(path).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="settings-path-row">
      <span className="settings-path-label">{label}</span>
      <code className="settings-path-value" onClick={handleCopy} title="点击复制">
        {path}
      </code>
      <span className={`settings-path-copied ${copied ? "visible" : ""}`}>
        已复制
      </span>
    </div>
  );
}
