/** Matches Rust ComicInfo */
export interface ComicInfo {
    id: number
    filePath: string
    fileName: string
    fileHash: string
    fileSize: number
    pageCount: number
    coverPath: string | null
    /** Absolute filesystem path to the cover WebP thumbnail */
    coverFilePath: string | null
    addedAt: string
    updatedAt: string
}

/** Matches Rust PageInfo */
export interface PageInfo {
    id: number
    comicId: number
    pageIdx: number
    fileName: string
    fileSize: number
}

/** Matches Rust ScanResult */
export interface ScanResult {
    totalFiles: number
    newComics: number
    updatedComics: number
    removedComics: number
    skippedComics: number
    errors: string[]
}

/** Matches Rust ScanProgress — emitted per-file during scanning. */
export interface ScanProgress {
    current: number
    total: number
    fileName: string
    status: 'skipped' | 'indexed' | 'error'
}

/** Matches Rust AppPaths */
export interface AppPaths {
    appDataDir: string
    dbPath: string
    thumbnailsDir: string
    pagesCacheDir: string
}

/** Matches Rust ClearCacheResult */
export interface ClearCacheResult {
    clearedPath: string
}

/** Matches Rust CacheSizes */
export interface CacheSizes {
    thumbnailsSize: string
    thumbnailsBytes: number
    pagesSize: string
    pagesBytes: number
    totalSize: string
    totalBytes: number
}

/** Matches Rust ServerInfo */
export interface ServerInfo {
    url: string
    ip: string
    port: number
}
