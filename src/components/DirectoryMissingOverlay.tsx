import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { useAppStore } from '../store/useAppStore'
import type { ComicInfo, ScanResult } from '../types'

/**
 * 目录缺失蒙版 — 当已配置的漫画库目录不存在时显示。
 * 定位在 app-main 区域（toolbar 下方），不会遮挡顶部工具栏。
 */
export function DirectoryMissingOverlay() {
    const { t } = useTranslation()
    const setLibraryPath = useAppStore(s => s.setLibraryPath)
    const setComics = useAppStore(s => s.setComics)
    const setLibraryPathMissing = useAppStore(s => s.setLibraryPathMissing)
    const setIsScanning = useAppStore(s => s.setIsScanning)

    const handlePickDirectory = useCallback(async () => {
        try {
            const selected = await open({
                directory: true,
                multiple: false,
                title: t('toolbar.pickDirTitle'),
            })
            if (selected && typeof selected === 'string') {
                setIsScanning(true)
                setLibraryPath(selected)

                const result = await invoke<ScanResult>('set_library_path', { path: selected })
                console.log('Scan result:', result)

                const comics = await invoke<ComicInfo[]>('get_comics')
                setComics(comics)
                setLibraryPathMissing(false)
            }
        } catch (e) {
            console.error('Directory picker error:', e)
        } finally {
            setIsScanning(false)
        }
    }, [t, setLibraryPath, setComics, setLibraryPathMissing, setIsScanning])

    return (
        <div className='dir-missing-overlay'>
            <div className='dir-missing-card'>
                <div className='dir-missing-icon'>📂</div>
                <h2 className='dir-missing-title'>{t('directoryMissing.title')}</h2>
                <p className='dir-missing-message'>{t('directoryMissing.message')}</p>
                <p className='dir-missing-hint'>{t('directoryMissing.hint')}</p>
                <button className='toolbar-btn' onClick={handlePickDirectory}>
                    {t('directoryMissing.pickDir')}
                </button>
            </div>
        </div>
    )
}
