import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import i18n from '../i18n'
import { invoke } from '@tauri-apps/api/core'
import type { AppPaths, CacheSizes, ClearCacheResult } from '../types'

type Tab = 'general' | 'storage' | 'about'

interface Props {
    onClose: () => void
}

/** 设置弹窗 — 采用侧边栏布局。 */
export function SettingsDialog({ onClose }: Props) {
    const { t } = useTranslation()
    const [tab, setTab] = useState<Tab>('storage')
    const [paths, setPaths] = useState<AppPaths | null>(null)
    const [sizes, setSizes] = useState<CacheSizes | null>(null)
    const [clearing, setClearing] = useState<'pages' | 'current' | 'all' | null>(null)
    const [lastCleared, setLastCleared] = useState<string | null>(null)
    const [confirmPopover, setConfirmPopover] = useState(false)

    // 加载路径和缓存大小
    const loadData = useCallback(() => {
        invoke<AppPaths>('get_app_paths')
            .then(setPaths)
            .catch(e => console.error('get_app_paths:', e))
        invoke<CacheSizes>('get_cache_sizes')
            .then(setSizes)
            .catch(e => console.error('get_cache_sizes:', e))
    }, [])

    useEffect(() => {
        loadData()
    }, [loadData])

    // 按 Escape 关闭
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
        <div className='dialog-overlay' onClick={onClose}>
            <div className='settings-dialog' onClick={e => e.stopPropagation()} role='dialog' aria-modal='true'>
                {/* 侧边栏 */}
                <nav className='settings-sidebar'>
                    <div className='settings-sidebar-title'>{t('settings.title')}</div>
                    <button
                        className={`settings-sidebar-item ${tab === 'general' ? 'active' : ''}`}
                        onClick={() => setTab('general')}
                    >
                        <svg
                            width='16'
                            height='16'
                            viewBox='0 0 24 24'
                            fill='none'
                            stroke='currentColor'
                            strokeWidth='2'
                            strokeLinecap='round'
                            strokeLinejoin='round'
                        >
                            <circle cx='12' cy='12' r='3' />
                            <path d='M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' />
                        </svg>
                        {t('settings.tabs.general')}
                    </button>
                    <button
                        className={`settings-sidebar-item ${tab === 'storage' ? 'active' : ''}`}
                        onClick={() => setTab('storage')}
                    >
                        <svg
                            width='16'
                            height='16'
                            viewBox='0 0 24 24'
                            fill='none'
                            stroke='currentColor'
                            strokeWidth='2'
                            strokeLinecap='round'
                            strokeLinejoin='round'
                        >
                            <ellipse cx='12' cy='5' rx='9' ry='3' />
                            <path d='M21 12c0 1.66-4 3-9 3s-9-1.34-9-3' />
                            <path d='M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5' />
                        </svg>
                        {t('settings.tabs.storage')}
                    </button>
                    <button
                        className={`settings-sidebar-item ${tab === 'about' ? 'active' : ''}`}
                        onClick={() => setTab('about')}
                    >
                        <svg
                            width='16'
                            height='16'
                            viewBox='0 0 24 24'
                            fill='none'
                            stroke='currentColor'
                            strokeWidth='2'
                            strokeLinecap='round'
                            strokeLinejoin='round'
                        >
                            <circle cx='12' cy='12' r='10' />
                            <line x1='12' y1='16' x2='12' y2='12' />
                            <line x1='12' y1='8' x2='12.01' y2='8' />
                        </svg>
                        {t('settings.tabs.about')}
                    </button>
                </nav>

                {/* 内容区 */}
                <div className='settings-content'>
                    {tab === 'general' && (
                        <>
                            <h2 className='settings-content-title'>{t('settings.tabs.general')}</h2>
                            <div className='settings-general-section'>
                                <label className='settings-general-label'>{t('settings.general.language')}</label>
                                <p className='settings-content-desc'>{t('settings.general.languageDesc')}</p>
                                <select
                                    className='settings-lang-select'
                                    value={i18n.language}
                                    onChange={async e => {
                                        const lang = e.target.value
                                        await invoke('set_language', { language: lang })
                                        i18n.changeLanguage(lang)
                                    }}
                                >
                                    <option value='zh'>中文</option>
                                    <option value='en'>English</option>
                                </select>
                            </div>
                        </>
                    )}

                    {tab === 'storage' && (
                        <>
                            <h2 className='settings-content-title'>{t('settings.tabs.storage')}</h2>
                            <p className='settings-content-desc'>{t('settings.storage.desc')}</p>

                            <div className='settings-path-list'>
                                {paths ? (
                                    <>
                                        <PathRow label={t('settings.storage.appData')} path={paths.appDataDir} />
                                        <PathRow label={t('settings.storage.database')} path={paths.dbPath} />
                                        <PathRow
                                            label={t('settings.storage.thumbnails')}
                                            path={paths.thumbnailsDir}
                                            size={sizes?.thumbnailsSize}
                                        />
                                        <PathRow
                                            label={t('settings.storage.pageCache')}
                                            path={paths.pagesCacheDir}
                                            size={sizes?.pagesSize}
                                            onClear={handleClearPages}
                                            clearing={clearing === 'pages'}
                                        />
                                        {sizes && (
                                            <div className='settings-cache-total'>
                                                {t('settings.storage.total', { size: sizes.totalSize })}
                                            </div>
                                        )}
                                    </>
                                ) : (
                                    <p className='settings-loading'>{t('settings.storage.loading')}</p>
                                )}
                            </div>

                            {/* 清除缓存按钮 */}
                            <div className='settings-cache-actions'>
                                <button
                                    className='dialog-btn dialog-btn-cancel'
                                    onClick={handleClearCurrent}
                                    disabled={clearing !== null}
                                >
                                    {clearing === 'current'
                                        ? t('settings.storage.clearing')
                                        : t('settings.storage.clearCurrent')}
                                </button>
                                <span className='settings-popover-anchor'>
                                    <button
                                        className='dialog-btn dialog-btn-danger'
                                        onClick={() => setConfirmPopover(true)}
                                        disabled={clearing !== null}
                                    >
                                        {clearing === 'all'
                                            ? t('settings.storage.clearing')
                                            : t('settings.storage.clearAll')}
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
                                    message={t('settings.storage.cleared', { path: lastCleared })}
                                    onDone={() => setLastCleared(null)}
                                />
                            )}
                        </>
                    )}

                    {tab === 'about' && (
                        <>
                            <h2 className='settings-content-title'>{t('settings.tabs.about')}</h2>
                            <p className='settings-content-desc'>{t('settings.about.title')}</p>
                            <div className='settings-about-info'>
                                <div className='settings-about-row'>
                                    <span className='settings-about-label'>{t('settings.about.version')}</span>
                                    <span>1.0.0</span>
                                </div>
                                <div className='settings-about-row'>
                                    <span className='settings-about-label'>{t('settings.about.techStack')}</span>
                                    <span>Tauri v2 · Rust · React · SQLite</span>
                                </div>
                                <div className='settings-about-row'>
                                    <span className='settings-about-label'>{t('settings.about.formats')}</span>
                                    <span>ZIP / CBZ</span>
                                </div>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>,
        document.body
    )
}

/** 单条路径行：标签 + 等宽路径（点击复制）+ 可选的占用空间和清除按钮。 */
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
    const { t } = useTranslation()
    const [copied, setCopied] = useState(false)

    const handleCopy = () => {
        navigator.clipboard.writeText(path).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
        })
    }

    return (
        <div className='settings-path-row'>
            <div className='settings-path-header'>
                <span className='settings-path-label'>{label}</span>
                {size !== undefined && <span className='settings-path-size'>{size}</span>}
                {onClear && (
                    <button
                        className='settings-path-clear-btn'
                        onClick={onClear}
                        disabled={clearing}
                        title={t('settings.storage.clearLabel', { label })}
                    >
                        {clearing ? '…' : '×'}
                    </button>
                )}
            </div>
            <code className='settings-path-value' onClick={handleCopy} title='点击复制'>
                {path}
            </code>
            <span className={`settings-path-copied ${copied ? 'visible' : ''}`}>{t('settings.path.copied')}</span>
        </div>
    )
}

/** 清除全部按钮上方的气泡确认。在设置内容区内部渲染，
 *  跟随内容自然滚动，由 overflow-y: auto 裁剪。 */
function ConfirmPopover({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
    const { t } = useTranslation()
    const popoverRef = useRef<HTMLDivElement>(null)

    // 点击外部或按 Escape 关闭
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
        <div ref={popoverRef} className='confirm-popover'>
            <p className='confirm-popover-text'>{t('settings.storage.confirmAll')}</p>
            <div className='confirm-popover-actions'>
                <button className='dialog-btn dialog-btn-cancel' onClick={onCancel}>
                    {t('library.cancel')}
                </button>
                <button className='dialog-btn dialog-btn-danger' onClick={onConfirm}>
                    {t('settings.storage.confirmBtn')}
                </button>
            </div>
        </div>
    )
}

/** Toast 通知 — 3 秒后自动消失。 */
function ClearToast({ message, onDone }: { message: string; onDone: () => void }) {
    useEffect(() => {
        const timer = setTimeout(onDone, 3000)
        return () => clearTimeout(timer)
    }, [onDone])

    return createPortal(<div className='clear-toast'>{message}</div>, document.body)
}
