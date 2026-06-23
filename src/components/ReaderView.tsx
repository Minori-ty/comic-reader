import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { PageInfo } from '../types'
import { useAppStore } from '../store/useAppStore'

/** 顶部导航栏高度，对应 CSS 变量 `--reader-header-height`。 */
const HEADER_HEIGHT = 44

/** overscan 与 preload 窗口大小 — 保持一致，确保图片提取覆盖所有已渲染行。 */
const OVERSCAN = 3

/** 每页高度的保守估算值（视口 90% 减去导航栏）。 */
function estimatedPageHeight() {
    return Math.round((window.innerHeight - HEADER_HEIGHT) * 0.9)
}

/**
 * 纵向滚动阅读器（webtoon/manhwa 风格）。
 *
 * 使用 `@tanstack/react-virtual` 仅渲染可见区域 + 少量 overscan 内的 DOM 节点。
 * 页面图片在滚动进入 preload 窗口时按需从 ZIP 中提取——不再需要在显示第一页前
 * 解压全部 200+ 页。
 */
export function ReaderView() {
    const currentComicId = useAppStore((s) => s.currentComicId)
    const goToLibrary = useAppStore((s) => s.goToLibrary)
    const comics = useAppStore((s) => s.comics)

    const [pages, setPages] = useState<PageInfo[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    // page_idx → asset:// URL 映射（页面滚动进入视野时惰性填充）
    const [pageUrls, setPageUrls] = useState<Map<number, string>>(new Map())

    // 跟踪进行中的请求，防止同一页重复提取
    const fetchingRef = useRef<Set<number>>(new Set())

    const scrollRef = useRef<HTMLDivElement>(null)

    const comic = useMemo(() => comics.find((c) => c.id === currentComicId), [comics, currentComicId])

    // ── 虚拟滚动 ──
    const virtualizer = useVirtualizer({
        count: pages.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: estimatedPageHeight,
        overscan: OVERSCAN,
        measureElement: (el) => el.getBoundingClientRect().height,
    })

    const visibleRange = virtualizer.range

    // ── 加载页面元数据（快速 — 仅 DB 查询，不涉及 ZIP 解压） ──
    useEffect(() => {
        if (!currentComicId) return
        setLoading(true)
        setError(null)
        setPageUrls(new Map())
        fetchingRef.current.clear()

        invoke<PageInfo[]>('get_comic_pages', { comicId: currentComicId })
            .then(setPages)
            .catch((e) => {
                console.error('Failed to load pages:', e)
                setError(String(e))
            })
            .finally(() => setLoading(false))
    }, [currentComicId])

    // ── 每次打开新漫画时重置滚动位置 ──
    // 通过 rAF 延迟执行，避免在 React 渲染阶段调用 scrollTo，
    // 防止 virtualizer 在生命周期内触发 flushSync。
    useEffect(() => {
        if (!loading && pages.length > 0) {
            const raf = requestAnimationFrame(() => {
                scrollRef.current?.scrollTo({ top: 0 })
            })
            return () => cancelAnimationFrame(raf)
        }
    }, [loading, pages.length])

    // ── 惰性提取进入 preload 窗口的页面 ──
    useEffect(() => {
        if (!visibleRange || pages.length === 0) return

        // 预加载可见范围前后的页面，覆盖整个 overscan 区域
        const start = Math.max(0, visibleRange.startIndex - OVERSCAN)
        const end = Math.min(pages.length - 1, visibleRange.endIndex + OVERSCAN)

        for (let i = start; i <= end; i++) {
            const pageIdx = pages[i]?.pageIdx
            if (pageIdx === undefined) continue
            if (pageUrls.has(pageIdx) || fetchingRef.current.has(pageIdx)) continue

            fetchingRef.current.add(pageIdx)
            invoke<string>('get_page_file_path', {
                comicId: currentComicId,
                pageIdx,
            })
                .then((filePath) => {
                    setPageUrls((prev) => {
                        const next = new Map(prev)
                        next.set(pageIdx, convertFileSrc(filePath))
                        return next
                    })
                })
                .catch((e) => {
                    console.error(`Failed to get page ${pageIdx}:`, e)
                })
                .finally(() => {
                    fetchingRef.current.delete(pageIdx)
                })
        }
    }, [visibleRange, pages, pageUrls, currentComicId])

    // ── 键盘导航 ──
    const handleKeyDown = useCallback(
        (e: KeyboardEvent) => {
            const el = scrollRef.current
            if (!el) return

            switch (e.key) {
                case 'PageDown':
                    e.preventDefault()
                    el.scrollBy({ top: el.clientHeight * 0.9, behavior: 'smooth' })
                    break
                case 'ArrowDown':
                    e.preventDefault()
                    el.scrollBy({ top: 200, behavior: 'smooth' })
                    break
                case 'PageUp':
                    e.preventDefault()
                    el.scrollBy({ top: -el.clientHeight * 0.9, behavior: 'smooth' })
                    break
                case 'ArrowUp':
                    e.preventDefault()
                    el.scrollBy({ top: -200, behavior: 'smooth' })
                    break
                case 'Home':
                    e.preventDefault()
                    el.scrollTo({ top: 0, behavior: 'smooth' })
                    break
                case 'End':
                    e.preventDefault()
                    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
                    break
                case 'Escape':
                    e.preventDefault()
                    goToLibrary()
                    break
            }
        },
        [goToLibrary],
    )

    useEffect(() => {
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [handleKeyDown])

    // ── 渲染 ──

    if (loading) {
        return (
            <div className="reader-loading">
                <div className="reader-loading-spinner" />
                <p>加载漫画中…</p>
            </div>
        )
    }

    if (error) {
        return (
            <div className="reader-error">
                <h2>加载漫画失败</h2>
                <p>{error}</p>
                <button onClick={goToLibrary}>返回库</button>
            </div>
        )
    }

    return (
        <div className="reader-view">
            <div className="reader-header">
                <button className="reader-back-btn" onClick={goToLibrary}>
                    返回
                </button>
                <span className="reader-title">{comic?.fileName ?? '阅读中'}</span>
                <span className="reader-page-info">{pages.length} 页</span>
            </div>

            <div ref={scrollRef} className="reader-scroll">
                <div
                    style={{
                        height: `${virtualizer.getTotalSize()}px`,
                        width: '100%',
                        position: 'relative',
                    }}
                >
                    {virtualizer.getVirtualItems().map((virtualItem) => {
                        const page = pages[virtualItem.index]
                        const imgSrc = pageUrls.get(page.pageIdx)

                        return (
                            <div
                                key={virtualItem.key}
                                data-index={virtualItem.index}
                                ref={virtualizer.measureElement}
                                className="reader-page"
                                style={{
                                    position: 'absolute',
                                    top: 0,
                                    left: 0,
                                    width: '100%',
                                    transform: `translateY(${virtualItem.start}px)`,
                                }}
                            >
                                {imgSrc ? (
                                    <img
                                        src={imgSrc}
                                        alt={`第 ${page.pageIdx + 1} 页`}
                                        onError={(e) => {
                                            console.error(`Failed to load page ${page.pageIdx}:`, e)
                                        }}
                                    />
                                ) : (
                                    <div className="reader-page-placeholder">
                                        <div className="reader-page-spinner" />
                                    </div>
                                )}
                                <div className="reader-page-number"># {page.pageIdx + 1}</div>
                            </div>
                        )
                    })}
                </div>
            </div>
        </div>
    )
}
