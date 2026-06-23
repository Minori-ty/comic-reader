import { useCallback, useEffect, useRef, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { ScanProgress, ScanResult } from '../types'
import { useAppStore } from '../store/useAppStore'
import { SettingsDialog } from './SettingsDialog'

/**
 * 顶部工具栏 — 目录选择、扫描控制、扫描进度条。
 */
export function Toolbar() {
    const libraryPath = useAppStore((s) => s.libraryPath)
    const setLibraryPath = useAppStore((s) => s.setLibraryPath)
    const setComics = useAppStore((s) => s.setComics)
    const setScanResult = useAppStore((s) => s.setScanResult)
    const setScanProgress = useAppStore((s) => s.setScanProgress)
    const scanProgress = useAppStore((s) => s.scanProgress)
    const setIsScanning = useAppStore((s) => s.setIsScanning)
    const isScanning = useAppStore((s) => s.isScanning)
    const scanResult = useAppStore((s) => s.scanResult)
    const currentView = useAppStore((s) => s.currentView)

    const searchQuery = useAppStore((s) => s.searchQuery)
    const setSearchQuery = useAppStore((s) => s.setSearchQuery)

    const scanInProgress = useRef(false)
    const [settingsOpen, setSettingsOpen] = useState(false)

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
                title: '选择漫画库目录',
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

            const comics = await invoke<any[]>('get_comics')
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
                <span className="toolbar-title">Comic Reader</span>
            </div>

            {/* 搜索 */}
            {currentView === 'library' && libraryPath && (
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
                        placeholder="搜索漫画…"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                    />
                    {searchQuery && (
                        <button className="toolbar-search-clear" onClick={() => setSearchQuery('')} title="清除搜索">
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
                    {libraryPath ? '修改目录' : '选择目录'}
                </button>
                {libraryPath && (
                    <button className="toolbar-btn toolbar-btn-scan" onClick={handleRescan} disabled={isScanning}>
                        {isScanning ? '扫描中…' : '扫描'}
                    </button>
                )}
                <button className="toolbar-btn toolbar-btn-icon" onClick={() => setSettingsOpen(true)} title="设置">
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
                    {scanResult.newComics > 0 && <span>+{scanResult.newComics} 新增 </span>}
                    {scanResult.updatedComics > 0 && <span>↻{scanResult.updatedComics} 更新 </span>}
                    {scanResult.removedComics > 0 && <span>-{scanResult.removedComics} 移除 </span>}
                    {scanResult.skippedComics > 0 && <span>✓{scanResult.skippedComics} 未变 </span>}
                    {scanResult.errors.length > 0 && (
                        <span className="scan-errors">⚠ {scanResult.errors.length} 错误</span>
                    )}
                </div>
            )}

            {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
        </div>
    )
}
