import { useEffect } from 'react'
import { Routes, Route } from 'react-router-dom'
import { invoke } from '@tauri-apps/api/core'
import QRCode from 'qrcode'
import i18n from './i18n'
import { Toolbar } from './components/Toolbar'
import { LibraryView } from './components/LibraryView'
import { ReaderView } from './components/ReaderView'
import { DirectoryMissingOverlay } from './components/DirectoryMissingOverlay'
import { useAppStore } from './store/useAppStore'
import type { ServerInfo } from './types'
import { QR_OPTIONS } from './constants'
import './App.css'

function App() {
    const setServerInfo = useAppStore(s => s.setServerInfo)
    const setQrDataUrl = useAppStore(s => s.setQrDataUrl)
    const libraryPath = useAppStore(s => s.libraryPath)
    const libraryPathMissing = useAppStore(s => s.libraryPathMissing)
    const setLibraryPath = useAppStore(s => s.setLibraryPath)
    const setLibraryPathMissing = useAppStore(s => s.setLibraryPathMissing)

    // 启动时从 Rust 加载当前语言（首次启动自动检测系统语言）
    useEffect(() => {
        invoke<string>('get_language')
            .then(lang => {
                if (lang !== i18n.language) {
                    i18n.changeLanguage(lang)
                }
            })
            .catch(e => {
                console.error('get_language:', e)
            })
    }, [])

    // 启动时获取已保存的 libraryPath，并检测目录是否仍然存在
    useEffect(() => {
        invoke<string | null>('get_library_path')
            .then(path => {
                if (path) {
                    setLibraryPath(path)
                    // 检测目录是否存在
                    invoke<boolean>('check_directory_exists', { path })
                        .then(exists => {
                            if (!exists) {
                                setLibraryPathMissing(true)
                            }
                        })
                        .catch(e => {
                            console.error('check_directory_exists:', e)
                            setLibraryPathMissing(true)
                        })
                }
            })
            .catch(e => {
                console.error('get_library_path:', e)
            })
    }, [setLibraryPath, setLibraryPathMissing])

    // 启动时检查局域网共享是否已在运行（前端重启但后端未停的情况）
    useEffect(() => {
        invoke<ServerInfo | null>('get_server_status')
            .then(info => {
                if (info) {
                    setServerInfo(info)
                    QRCode.toDataURL(info.url, QR_OPTIONS).then(setQrDataUrl)
                }
            })
            .catch(e => {
                console.error('get_server_status:', e)
            })
    }, [setServerInfo, setQrDataUrl])

    return (
        <div className='app'>
            <Toolbar />
            <main className='app-main'>
                {libraryPath !== null && libraryPathMissing && <DirectoryMissingOverlay />}
                <Routes>
                    <Route path='/' element={<LibraryView />} />
                    <Route path='/reader/:comicId' element={<ReaderView />} />
                </Routes>
            </main>
        </div>
    )
}

export default App
