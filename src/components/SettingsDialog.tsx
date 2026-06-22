import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import type { AppPaths, CacheSizes, ClearCacheResult } from '../types'

type Tab = 'storage' | 'about'

interface Props {
    onClose: () => void
}

/** Settings dialog with a sidebar layout. */
export function SettingsDialog({ onClose }: Props) {
    const [tab, setTab] = useState<Tab>('storage')
    const [paths, setPaths] = useState<AppPaths | null>(null)
    const [sizes, setSizes] = useState<CacheSizes | null>(null)
    const [clearing, setClearing] = useState<'pages' | 'current' | 'all' | null>(null)
    const [lastCleared, setLastCleared] = useState<string | null>(null)
    const [confirmPopover, setConfirmPopover] = useState(false)

    // Load paths and cache sizes
    const loadData = useCallback(() => {
        invoke<AppPaths>('get_app_paths')
            .then(setPaths)
            .catch((e) => console.error('get_app_paths:', e))
        invoke<CacheSizes>('get_cache_sizes')
            .then(setSizes)
            .catch((e) => console.error('get_cache_sizes:', e))
    }, [])

    useEffect(() => {
        loadData()
    }, [loadData])

    // Close on Escape
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', handleKeyDown)
        return () => document.removeEventListener('keydown', handleKeyDown)
    }, [onClose])

    const handleClearCurrent = async () => {
        setClearing('current')
        try {
            const result = await invoke<ClearCacheResult>('clear_current_cache')
            setLastCleared(result.clearedPath)
            loadData()
        } catch (e) {
            console.error('clear_current_cache:', e)
        }
        setClearing(null)
    }

    const handleClearPages = async () => {
        setClearing('pages')
        try {
            const result = await invoke<ClearCacheResult>('clear_pages_cache')
            setLastCleared(result.clearedPath)
            loadData()
        } catch (e) {
            console.error('clear_pages_cache:', e)
        }
        setClearing(null)
    }

    const handleClearAll = async () => {
        setClearing('all')
        try {
            const result = await invoke<ClearCacheResult>('clear_all_cache')
            setLastCleared(result.clearedPath)
            loadData()
        } catch (e) {
            console.error('clear_all_cache:', e)
        }
        setClearing(null)
    }

    return createPortal(
        <div className="dialog-overlay" onClick={onClose}>
            <div className="settings-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
                {/* Sidebar */}
                <nav className="settings-sidebar">
                    <div className="settings-sidebar-title">设置</div>
                    <button
                        className={`settings-sidebar-item ${tab === 'storage' ? 'active' : ''}`}
                        onClick={() => setTab('storage')}
                    >
                        <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <ellipse cx="12" cy="5" rx="9" ry="3" />
                            <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                        </svg>
                        存储管理
                    </button>
                    <button
                        className={`settings-sidebar-item ${tab === 'about' ? 'active' : ''}`}
                        onClick={() => setTab('about')}
                    >
                        <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <circle cx="12" cy="12" r="10" />
                            <line x1="12" y1="16" x2="12" y2="12" />
                            <line x1="12" y1="8" x2="12.01" y2="8" />
                        </svg>
                        关于
                    </button>
                </nav>

                {/* Content */}
                <div className="settings-content">
                    {tab === 'storage' && (
                        <>
                            <h2 className="settings-content-title">存储管理</h2>
                            <p className="settings-content-desc">
                                当前漫画库的缓存路径及占用空间。切换不同库目录时，缓存会自动隔离。
                            </p>

                            <div className="settings-path-list">
                                {paths ? (
                                    <>
                                        <PathRow label="应用数据目录" path={paths.appDataDir} />
                                        <PathRow label="数据库" path={paths.dbPath} />
                                        <PathRow
                                            label="封面缩略图"
                                            path={paths.thumbnailsDir}
                                            size={sizes?.thumbnailsSize}
                                        />
                                        <PathRow
                                            label="页面缓存"
                                            path={paths.pagesCacheDir}
                                            size={sizes?.pagesSize}
                                            onClear={handleClearPages}
                                            clearing={clearing === 'pages'}
                                        />
                                        {sizes && (
                                            <div className="settings-cache-total">缓存总计：{sizes.totalSize}</div>
                                        )}
                                    </>
                                ) : (
                                    <p className="settings-loading">加载中…</p>
                                )}
                            </div>

                            {/* Clear cache buttons */}
                            <div className="settings-cache-actions">
                                <button
                                    className="dialog-btn dialog-btn-cancel"
                                    onClick={handleClearCurrent}
                                    disabled={clearing !== null}
                                >
                                    {clearing === 'current' ? '清除中…' : '清除当前库缓存'}
                                </button>
                                <span className="settings-popover-anchor">
                                    <button
                                        className="dialog-btn dialog-btn-danger"
                                        onClick={() => setConfirmPopover(true)}
                                        disabled={clearing !== null}
                                    >
                                        {clearing === 'all' ? '清除中…' : '清除全部缓存'}
                                    </button>
                                    {confirmPopover && (
                                        <ConfirmPopover
                                            onCancel={() => setConfirmPopover(false)}
                                            onConfirm={() => {
                                                setConfirmPopover(false)
                                                handleClearAll()
                                            }}
                                        />
                                    )}
                                </span>
                            </div>

                            {lastCleared && (
                                <ClearToast
                                    message={`已清除: ${lastCleared}`}
                                    onDone={() => setLastCleared(null)}
                                />
                            )}
                        </>
                    )}

                    {tab === 'about' && (
                        <>
                            <h2 className="settings-content-title">关于</h2>
                            <p className="settings-content-desc">Comic Reader — 高性能本地漫画阅读器</p>
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
    )
}

/** A single path row: label, monospace path (copy on click), optional size badge and clear button. */
function PathRow({
    label,
    path,
    size,
    onClear,
    clearing,
}: {
    label: string
    path: string
    size?: string
    onClear?: () => void
    clearing?: boolean
}) {
    const [copied, setCopied] = useState(false)

    const handleCopy = () => {
        navigator.clipboard.writeText(path).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
        })
    }

    return (
        <div className="settings-path-row">
            <div className="settings-path-header">
                <span className="settings-path-label">{label}</span>
                {size !== undefined && <span className="settings-path-size">{size}</span>}
                {onClear && (
                    <button
                        className="settings-path-clear-btn"
                        onClick={onClear}
                        disabled={clearing}
                        title={`清除${label}`}
                    >
                        {clearing ? '…' : '×'}
                    </button>
                )}
            </div>
            <code className="settings-path-value" onClick={handleCopy} title="点击复制">
                {path}
            </code>
            <span className={`settings-path-copied ${copied ? 'visible' : ''}`}>已复制</span>
        </div>
    )
}

/** Popover anchored above the clear-all button. Rendered inline so it scrolls
 *  naturally with the settings content and is clipped by overflow-y: auto. */
function ConfirmPopover({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
    const popoverRef = useRef<HTMLDivElement>(null)

    // Close on click outside / Escape
    useEffect(() => {
        const handleMouseDown = (e: MouseEvent) => {
            if (popoverRef.current?.contains(e.target as Node)) return
            onCancel()
        }
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onCancel()
        }
        document.addEventListener('mousedown', handleMouseDown)
        document.addEventListener('keydown', handleKeyDown)
        return () => {
            document.removeEventListener('mousedown', handleMouseDown)
            document.removeEventListener('keydown', handleKeyDown)
        }
    }, [onCancel])

    return (
        <div ref={popoverRef} className="confirm-popover">
            <p className="confirm-popover-text">
                ⚠️ 此操作将清除<strong>所有库</strong>的全部缓存和数据库记录，不可撤销。确定继续？
            </p>
            <div className="confirm-popover-actions">
                <button className="dialog-btn dialog-btn-cancel" onClick={onCancel}>
                    取消
                </button>
                <button className="dialog-btn dialog-btn-danger" onClick={onConfirm}>
                    确定清除全部
                </button>
            </div>
        </div>
    )
}

/** Toast notification — auto-dismisses after 3 seconds. */
function ClearToast({ message, onDone }: { message: string; onDone: () => void }) {
    useEffect(() => {
        const timer = setTimeout(onDone, 3000);
        return () => clearTimeout(timer);
    }, [onDone]);

    return createPortal(
        <div className="clear-toast">{message}</div>,
        document.body,
    );
}
