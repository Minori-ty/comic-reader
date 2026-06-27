import { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'
import { fetchComics, coverUrl, type ComicEntry } from '../api'

const CARD_W = 165
const CARD_H = 300
const GAP = 12
/** 窗口宽度转为可用内容宽度的扣除量（滚动条 ~4px + lib-scroll padding 20px） */
const CHROME = 24

/** 组件卸载后缓存滚动位置 */
let cachedScrollTop = 0

export function Library() {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const parentRef = useRef<HTMLDivElement>(null)
    const [comics, setComics] = useState<ComicEntry[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [vw, setVw] = useState(window.innerWidth)
    const [search, setSearch] = useState('')

    useEffect(() => {
        const onResize = () => setVw(window.innerWidth)
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
    }, [])

    useEffect(() => {
        fetchComics()
            .then(data => {
                setComics(data)
                setLoading(false)
            })
            .catch(e => {
                setError(e.message)
                setLoading(false)
            })
    }, [])

    // 自适应列数
    const columns = useMemo(() => {
        const avail = vw - CHROME
        return Math.max(1, Math.floor((avail + GAP) / (CARD_W + GAP)))
    }, [vw])

    const filtered = useMemo(() => {
        if (!search.trim()) return comics
        const q = search.toLowerCase()
        return comics.filter(c => c.fileName.toLowerCase().includes(q))
    }, [comics, search])

    const rowCount = Math.ceil(filtered.length / columns)

    const virtualizer = useVirtualizer({
        count: rowCount,
        getScrollElement: () => parentRef.current,
        estimateSize: () => CARD_H + GAP,
        overscan: 2,
        initialOffset: cachedScrollTop,
    })

    const openReader = useCallback(
        (comic: ComicEntry) => {
            cachedScrollTop = parentRef.current?.scrollTop ?? 0
            navigate(`/reader/${comic.id}`, { state: { title: comic.fileName } })
        },
        [navigate]
    )

    if (loading) {
        return (
            <div className='loading-view'>
                <div className='spinner' />
                <p>{t('web.library.loading')}</p>
            </div>
        )
    }

    if (error) {
        return (
            <div className='empty-view'>
                <div className='empty-icon'>⚠️</div>
                <h2>{t('web.library.loadError')}</h2>
                <p>{error}</p>
            </div>
        )
    }

    if (comics.length === 0) {
        return (
            <div className='empty-view'>
                <div className='empty-icon'>📚</div>
                <h2>{t('web.library.empty')}</h2>
                <p>{t('web.library.emptyHint')}</p>
            </div>
        )
    }

    return (
        <div className='library-page'>
            <div className='lib-header'>
                <h1>{t('web.library.title')}</h1>
                <span className='lib-count'>{t('web.library.count', { count: comics.length })}</span>
            </div>
            <div className='lib-search-bar'>
                <svg
                    className='lib-search-icon'
                    width='15'
                    height='15'
                    viewBox='0 0 24 24'
                    fill='none'
                    stroke='currentColor'
                    strokeWidth='2'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                >
                    <circle cx='11' cy='11' r='8' />
                    <line x1='21' y1='21' x2='16.65' y2='16.65' />
                </svg>
                <input
                    className='lib-search-input'
                    type='text'
                    placeholder={t('web.library.searchPlaceholder')}
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                />
                {search && (
                    <button className='lib-search-clear' onClick={() => setSearch('')}>
                        ×
                    </button>
                )}
            </div>
            <div ref={parentRef} className='lib-scroll'>
                {filtered.length === 0 ? (
                    <div className='empty-view'>
                        <div className='empty-icon'>🔍</div>
                        <h2>{t('web.library.noResults')}</h2>
                        <p>{t('web.library.noResultsHint', { search })}</p>
                    </div>
                ) : (
                    <div
                        style={{
                            height: `${virtualizer.getTotalSize()}px`,
                            width: '100%',
                            position: 'relative',
                        }}
                    >
                        {virtualizer.getVirtualItems().map(virtualRow => (
                            <div
                                key={virtualRow.key}
                                style={{
                                    position: 'absolute',
                                    top: 0,
                                    left: 0,
                                    width: '100%',
                                    height: `${virtualRow.size}px`,
                                    transform: `translateY(${virtualRow.start}px)`,
                                    display: 'grid',
                                    gridTemplateColumns: `repeat(${columns}, ${CARD_W}px)`,
                                    gap: `${GAP}px`,
                                    justifyContent: 'center',
                                    padding: '0 0 12px 0',
                                }}
                            >
                                {Array.from({ length: columns }).map((_, colIdx) => {
                                    const idx = virtualRow.index * columns + colIdx
                                    if (idx >= filtered.length) {
                                        return <div key={`empty-${colIdx}`} />
                                    }
                                    const comic = filtered[idx]
                                    return (
                                        <div key={comic.id} className='comic-card' onClick={() => openReader(comic)}>
                                            <div className='card-cover'>
                                                {comic.coverUrl ? (
                                                    <img
                                                        src={coverUrl(comic.id)}
                                                        alt={comic.fileName}
                                                        loading='lazy'
                                                        onError={e => {
                                                            ;(e.target as HTMLImageElement).style.display = 'none'
                                                            ;(
                                                                e.target as HTMLImageElement
                                                            ).nextElementSibling?.setAttribute('style', 'display:flex')
                                                        }}
                                                    />
                                                ) : null}
                                                <div
                                                    className='card-placeholder'
                                                    style={{ display: comic.coverUrl ? 'none' : 'flex' }}
                                                >
                                                    📖
                                                </div>
                                            </div>
                                            <div className='card-name' title={comic.fileName}>
                                                {comic.fileName}
                                            </div>
                                            <div className='card-pages'>
                                                {t('web.reader.pages', { count: comic.pageCount })}
                                            </div>
                                        </div>
                                    )
                                })}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}
