import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import QRCode from 'qrcode'
import i18n from '../i18n'
import type { ComicInfo, ScanProgress, ScanResult, ServerInfo } from '../types'
import { QR_OPTIONS } from '../constants'
import { useAppStore } from '../store/useAppStore'
import { SettingsDialog } from './SettingsDialog'

/**
 * 顶部工具栏 — 目录选择、扫描控制、扫描进度条。
 */
export function Toolbar() {
    const { t } = useTranslation()
    const libraryPath = useAppStore((s) => s.libraryPath)
    const setLibraryPath = useAppStore((s) => s.setLibraryPath)
    const setComics = useAppStore((s) => s.setComics)
    const setScanResult = useAppStore((s) => s.setScanResult)
    const setScanProgress = useAppStore((s) => s.setScanProgress)
    const scanProgress = useAppStore((s) => s.scanProgress)
    const setIsScanning = useAppStore((s) => s.setIsScanning)
    const isScanning = useAppStore((s) => s.isScanning)
    const scanResult = useAppStore((s) => s.scanResult)

    const location = useLocation()
    const isLibrary = location.pathname === '/'

    const searchQuery = useAppStore((s) => s.searchQuery)
    const setSearchQuery = useAppStore((s) => s.setSearchQuery)

    const scanInProgress = useRef(false)
    const [settingsOpen, setSettingsOpen] = useState(false)

    // ── LAN 共享状态（来自 Zustand，跨路由保持） ──
    const serverInfo = useAppStore((s) => s.serverInfo)
    const qrDataUrl = useAppStore((s) => s.qrDataUrl)
    const shareOpen = useAppStore((s) => s.shareOpen)
    const shareLoading = useAppStore((s) => s.shareLoading)
    const shareError = useAppStore((s) => s.shareError)
    const setServerInfo = useAppStore((s) => s.setServerInfo)
    const setQrDataUrl = useAppStore((s) => s.setQrDataUrl)
    const setShareOpen = useAppStore((s) => s.setShareOpen)
    const setShareLoading = useAppStore((s) => s.setShareLoading)
    const setShareError = useAppStore((s) => s.setShareError)
    const [urlCopied, setUrlCopied] = useState(false)

    // 监听逐文件扫描进度事件，通过 rAF 节流
    useEffect(() => {
        let rafId: number | null = null
        let latest: ScanProgress | null = null

        const unlisten = listen<ScanProgress>('scan-progress', (event) => {
            latest = event.payload
            if (rafId === null) {
                rafId = requestAnimationFrame(() => {
                    if (latest) setScanProgress(latest)
                    rafId = null
                })
            }
        })
        return () => {
            unlisten.then((fn) => fn())
            if (rafId !== null) cancelAnimationFrame(rafId)
        }
    }, [setScanProgress])

    // 监听语言变更事件（来自其他窗口或 set_language 命令）
    useEffect(() => {
        const unlisten = listen<string>('language-changed', (event) => {
            i18n.changeLanguage(event.payload);
        });
        return () => { unlisten.then((fn) => fn()); };
    }, []);

    // 扫描结果 3 秒后自动隐藏
    useEffect(() => {
        if (!scanResult) return
        const timer = setTimeout(() => setScanResult(null), 3000)
        return () => clearTimeout(timer)
    }, [scanResult, setScanResult])

    const handlePickDirectory = useCallback(async () => {
        try {
            const selected = await open({
                directory: true,
                multiple: false,
                title: t('toolbar.pickDirTitle'),
            })
            if (selected && typeof selected === 'string') {
                setLibraryPath(selected)
                await doScan({ isNewPath: true, path: selected })
            }
        } catch (e) {
            console.error('Directory picker error:', e)
        }
    }, [])

    const handleRescan = useCallback(async () => {
        if (libraryPath) {
            await doScan({ isNewPath: false, path: libraryPath })
        }
    }, [libraryPath])

    // ── LAN 共享 ──
    const handleStartShare = useCallback(async () => {
        setShareLoading(true)
        setShareError(null)
        setServerInfo(null)
        setQrDataUrl(null)
        try {
            const port = 9527
            const info = await invoke<ServerInfo>('start_server', { port })
            setServerInfo(info)
            // 生成QR码（附加语言参数）
            const shareUrl = `${info.url}?lang=${i18n.language}`
            const dataUrl = await QRCode.toDataURL(shareUrl, QR_OPTIONS)
            setQrDataUrl(dataUrl)
        } catch (e) {
            setShareError(String(e))
        } finally {
            setShareLoading(false)
        }
    }, [setServerInfo, setQrDataUrl, setShareLoading, setShareError])

    const handleStopShare = useCallback(async () => {
        try {
            await invoke('stop_server')
        } catch (e) {
            console.error('stop_server:', e)
        }
        setServerInfo(null)
        setQrDataUrl(null)
        setShareOpen(false)
    }, [setServerInfo, setQrDataUrl, setShareOpen])

    const doScan = async ({ isNewPath, path }: { isNewPath: boolean; path: string }) => {
        if (scanInProgress.current) return
        scanInProgress.current = true
        setIsScanning(true)
        setScanResult(null)
        setScanProgress(null)

        try {
            const command = isNewPath ? 'set_library_path' : 'scan_library'
            const args: Record<string, unknown> = isNewPath ? { path } : {}
            const result = await invoke<ScanResult>(command, args)
            setScanResult(result)

            const comics = await invoke<ComicInfo[]>('get_comics')
            setComics(comics)
        } catch (e) {
            console.error('Scan error:', e)
            setScanResult({
                totalFiles: 0,
                newComics: 0,
                updatedComics: 0,
                removedComics: 0,
                skippedComics: 0,
                errors: [String(e)],
            })
        } finally {
            setIsScanning(false)
            scanInProgress.current = false
        }
    }

    // 构建进度文本
    const progressText = scanProgress ? `${scanProgress.current}/${scanProgress.total}` : null
    const progressPct = scanProgress ? Math.round((scanProgress.current / scanProgress.total) * 100) : 0

    return (
        <div className="toolbar">
            <div className="toolbar-left">
                <span className="toolbar-title">{t('toolbar.title')}</span>
            </div>

            {/* 搜索 */}
            {isLibrary && libraryPath && (
                <div className="toolbar-search">
                    <svg
                        className="toolbar-search-icon"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <circle cx="11" cy="11" r="8" />
                        <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <input
                        className="toolbar-search-input"
                        type="text"
                        placeholder={t('toolbar.searchPlaceholder')}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                    />
                    {searchQuery && (
                        <button className="toolbar-search-clear" onClick={() => setSearchQuery('')} title={t('toolbar.clearSearch')}>
                            ×
                        </button>
                    )}
                </div>
            )}

            <div className="toolbar-right">
                {libraryPath && (
                    <span className="toolbar-path" title={libraryPath}>
                        {libraryPath}
                    </span>
                )}
                <button className="toolbar-btn" onClick={handlePickDirectory} disabled={isScanning}>
                    {libraryPath ? t('toolbar.changeDir') : t('toolbar.pickDir')}
                </button>
                {libraryPath && (
                    <button className="toolbar-btn toolbar-btn-scan" onClick={handleRescan} disabled={isScanning}>
                        {isScanning ? t('toolbar.scanning') : t('toolbar.scan')}
                    </button>
                )}
                <button
                    className="toolbar-btn"
                    onClick={() => {
                        if (serverInfo) {
                            handleStopShare();
                        } else {
                            setShareOpen(true);
                            handleStartShare();
                        }
                    }}
                    disabled={isScanning || shareLoading}
                    title={serverInfo ? t('toolbar.stopShare') : t('toolbar.share')}
                >
                    {shareLoading ? t('toolbar.starting') : serverInfo ? t('toolbar.stopShare') : t('toolbar.share')}
                </button>
                <button className="toolbar-btn toolbar-btn-icon" onClick={() => setSettingsOpen(true)} title={t('toolbar.settings')}>
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
                        <circle cx="12" cy="12" r="3" />
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                </button>
            </div>

            {/* 扫描进度条 */}
            {isScanning && scanProgress && (
                <div className="scan-progress-bar-container">
                    <div className="scan-progress-bar-fill" style={{ width: `${progressPct}%` }} />
                    <span className="scan-progress-text">{progressText}</span>
                </div>
            )}

            {scanResult && (
                <div className={`scan-summary ${scanResult.errors.length > 0 ? 'scan-summary-errors' : ''}`}>
                    {scanResult.newComics > 0 && <span>+{scanResult.newComics} {t('scan.newAdded')} </span>}
                    {scanResult.updatedComics > 0 && <span>↻{scanResult.updatedComics} {t('scan.updated')} </span>}
                    {scanResult.removedComics > 0 && <span>-{scanResult.removedComics} {t('scan.removed')} </span>}
                    {scanResult.skippedComics > 0 && <span>✓{scanResult.skippedComics} {t('scan.unchanged')} </span>}
                    {scanResult.errors.length > 0 && (
                        <span className="scan-errors">⚠ {scanResult.errors.length} {t('scan.errors')}</span>
                    )}
                </div>
            )}

            {/* ── LAN 共享弹窗 ── */}
            {shareOpen && createPortal(
                <div className="dialog-overlay" onClick={() => setShareOpen(false)}>
                    <div className="share-dialog" onClick={(e) => e.stopPropagation()}>
                        <h3 className="share-dialog-title">{t('share.title')}</h3>

                        {shareLoading ? (
                            <div className="share-loading">
                                <div className="reader-loading-spinner" />
                                <p>{t('share.startingMsg')}</p>
                            </div>
                        ) : shareError ? (
                            <div className="share-error">
                                <p>{t('share.startFailed')}</p>
                                <p className="share-error-msg">{shareError}</p>
                            </div>
                        ) : serverInfo && qrDataUrl ? (
                            <>
                                <img src={qrDataUrl} alt="QR Code" className="share-qr" />
                                <code
                                    className="share-url"
                                    onClick={() => {
                                        const shareUrl = `${serverInfo.url}?lang=${i18n.language}`;
                                        navigator.clipboard.writeText(shareUrl).then(() => {
                                            setUrlCopied(true);
                                            setTimeout(() => setUrlCopied(false), 1500);
                                        });
                                    }}
                                    title={t('share.copyTitle')}
                                >
                                    {serverInfo.url}?lang={i18n.language}
                                </code>
                                <span className={`share-url-copied ${urlCopied ? 'visible' : ''}`}>{t('share.copied')}</span>
                                <p className="share-hint">
                                    {t('share.hint')}
                                </p>
                            </>
                        ) : null}

                        <div className="share-dialog-actions">
                            {serverInfo && !shareLoading && (
                                <button className="dialog-btn dialog-btn-danger" onClick={handleStopShare}>
                                    {t('share.stop')}
                                </button>
                            )}
                            <button className="dialog-btn dialog-btn-cancel" onClick={() => setShareOpen(false)}>
                                {t('share.close')}
                            </button>
                        </div>
                    </div>
                </div>,
                document.body,
            )}

            {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
        </div>
    )
}
