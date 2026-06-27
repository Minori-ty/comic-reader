import { memo, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { convertFileSrc } from '@tauri-apps/api/core'
import type { ComicInfo } from '../types'

/** A [start, end] match range from Fuse.js. */
export type HighlightRange = readonly number[]

interface ComicCardProps {
    comic: ComicInfo
    onClick: (comicId: number) => void
    /** Notify the parent to show a context menu at the given position. */
    onContextMenu: (e: React.MouseEvent, comic: ComicInfo) => void
    /** Fuse.js match ranges for highlighting the title. */
    highlightRanges?: readonly HighlightRange[]
}

/**
 * A single comic cover card in the library grid.
 * Uses Tauri's built-in asset protocol via convertFileSrc() to load
 * the WebP thumbnail from the local filesystem.
 */
export const ComicCard = memo(function ComicCard({ comic, onClick, onContextMenu, highlightRanges }: ComicCardProps) {
    const { t } = useTranslation()
    const coverSrc = useMemo(() => {
        if (comic.coverFilePath) {
            return convertFileSrc(comic.coverFilePath)
        }
        return null
    }, [comic.coverFilePath])

    const handleContextMenu = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault()
            onContextMenu(e, comic)
        },
        [comic, onContextMenu]
    )

    // Render title with highlight spans for matched characters
    const renderedTitle = useMemo(() => {
        const name = comic.fileName
        if (!highlightRanges || highlightRanges.length === 0) {
            return name
        }
        // Fuse indices are [start, end] inclusive. Merge overlapping ranges.
        const sorted = highlightRanges.map(r => [r[0], r[1]] as [number, number]).sort((a, b) => a[0] - b[0])
        const merged: [number, number][] = []
        for (const [s, e] of sorted) {
            const prev = merged[merged.length - 1]
            if (prev && s <= prev[1] + 1) {
                prev[1] = Math.max(prev[1], e)
            } else {
                merged.push([s, e])
            }
        }
        // Build segments
        const segments: (string | React.ReactNode)[] = []
        let cursor = 0
        for (const [s, e] of merged) {
            if (cursor < s) {
                segments.push(name.slice(cursor, s))
            }
            segments.push(
                <mark key={s} className='comic-card-highlight'>
                    {name.slice(s, e + 1)}
                </mark>
            )
            cursor = e + 1
        }
        if (cursor < name.length) {
            segments.push(name.slice(cursor))
        }
        return segments
    }, [comic.fileName, highlightRanges])

    return (
        <div
            className='comic-card'
            onClick={() => onClick(comic.id)}
            onContextMenu={handleContextMenu}
            role='button'
            tabIndex={0}
            onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onClick(comic.id)
                }
            }}
        >
            <div className='comic-card-cover'>
                {coverSrc ? (
                    <img src={coverSrc} alt={comic.fileName} loading='lazy' decoding='async' />
                ) : (
                    <div className='comic-card-placeholder'>
                        <span>{t('comicCard.noCover')}</span>
                    </div>
                )}
            </div>
            <div className='comic-card-title' title={comic.fileName}>
                {renderedTitle}
            </div>
            <div className='comic-card-pages'>{t('comicCard.pages', { count: comic.pageCount })}</div>
        </div>
    )
})
