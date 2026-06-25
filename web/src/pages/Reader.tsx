import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'
import { fetchPages, pageUrl, type PageEntry } from '../api'

export function Reader() {
    const { t } = useTranslation()
    const { comicId } = useParams<{ comicId: string }>()
    const navigate = useNavigate()
    const location = useLocation()
    const scrollRef = useRef<HTMLDivElement>(null)
    const [pages, setPages] = useState<PageEntry[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    // 从路由 state 获取 title，回退到 comicId
    const title = (location.state as { title?: string } | null)?.title || `漫画 #${comicId}`

    // Escape 返回首页
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                navigate(-1)
            }
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
    }, [navigate])

    useEffect(() => {
        if (!comicId) return
        setLoading(true)
        fetchPages(Number(comicId))
            .then((data) => {
                setPages(data)
                setLoading(false)
            })
            .catch((e) => {
                setError(e.message)
                setLoading(false)
            })
    }, [comicId])

    const virtualizer = useVirtualizer({
        count: pages.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 600,
        overscan: 2,
    })

    if (loading) {
        return (
            <div className="loading-view">
                <div className="spinner" />
                <p>{t('web.reader.loading')}</p>
            </div>
        )
    }

    if (error) {
        return (
            <div className="reader-page-wrap">
                <div className="reader-header">
                    <button className="reader-back" onClick={() => navigate('/')}>
                        {t('web.reader.back')}
                    </button>
                    <span className="reader-title">{t('web.reader.error')}</span>
                </div>
                <div className="empty-view">
                    <h2>{t('web.reader.loadError')}</h2>
                    <p>{error}</p>
                </div>
            </div>
        )
    }

    return (
        <div className="reader-page-wrap">
            <div className="reader-header">
                <button className="reader-back" onClick={() => navigate('/')}>
                    {t('web.reader.back')}
                </button>
                <span className="reader-title">{title}</span>
                <span className="reader-count">{t('web.reader.pages', { count: pages.length })}</span>
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
                        const p = pages[virtualItem.index]
                        if (!p) return null
                        return (
                            <div
                                key={virtualItem.key}
                                style={{
                                    position: 'absolute',
                                    top: 0,
                                    left: 0,
                                    width: '100%',
                                    transform: `translateY(${virtualItem.start}px)`,
                                }}
                                data-index={virtualItem.index}
                                ref={virtualizer.measureElement}
                            >
                                <img
                                    src={pageUrl(Number(comicId), p.pageIdx)}
                                    alt={t('web.reader.pageAlt', { n: p.pageIdx + 1 })}
                                    loading="lazy"
                                    style={{ width: '100%', display: 'block' }}
                                    onError={(e) => {
                                        const img = e.target as HTMLImageElement
                                        img.style.display = 'none'
                                        const ph = img.parentElement!.querySelector('.page-ph') as HTMLElement
                                        if (ph) ph.style.display = 'flex'
                                    }}
                                />
                                <div
                                    className="page-ph"
                                    style={{
                                        display: 'none',
                                        minHeight: '60vh',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                    }}
                                >
                                    <div className="spinner" />
                                </div>
                                <div className="page-num">
                                    {t('web.reader.pageNum', { current: p.pageIdx + 1, total: pages.length })}
                                </div>
                            </div>
                        )
                    })}
                </div>
            </div>
        </div>
    )
}
