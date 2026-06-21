# Comic Reader — Tauri v2 + Rust + React

Local comic/manga reader that scans directories of ZIP/CBZ files, indexes them in SQLite, generates WebP cover thumbnails, and reads pages directly from ZIPs via a Tauri asset protocol.

## Project Structure

```
src/                          # React frontend (Vite + TypeScript)
├── main.tsx                  # Entry point
├── App.tsx                   # Root: routes between Library / Reader
├── App.css                   # All global styles + CSS variables
├── types/index.ts            # TS interfaces matching Rust models
├── store/useAppStore.ts      # Zustand store (single global store)
└── components/
    ├── Toolbar.tsx           # Top bar: directory picker, scan, search, settings
    ├── LibraryView.tsx       # Virtual-scrolled grid of comic covers
    ├── ComicCard.tsx         # Single cover thumbnail card with highlight support
    ├── ReaderView.tsx        # Scroll-based comic reader (webtoon mode)
    └── SettingsDialog.tsx    # Settings modal: storage info, cache management

src-tauri/src/                # Rust backend
├── main.rs                   # Thin passthrough → lib::run()
├── lib.rs                    # Builder setup: plugins, state, commands
├── commands.rs               # All #[tauri::command] IPC handlers
├── db.rs                     # SQLite init, CRUD, config KV store
├── models.rs                 # Serde structs shared with frontend
├── scanner.rs                # Library scanner (walkdir + rayon + db insert)
├── thumbnail.rs              # WebP cover thumbnail generation
└── protocol.rs               # (If present) Custom protocol handler
```

## Key Architecture

### State Management
- **Zustand** store (`useAppStore.ts`) — single source of truth
- State shape: `libraryPath`, `comics[]`, `searchQuery`, `scanResult`, `scanProgress`, `isScanning`, `currentView`, `currentComicId`
- Actions: `setComics`, `upsertComic` (for real-time scan updates), `openReader`, `goToLibrary`, etc.

### IPC Pattern
- Frontend calls Rust via `invoke<ReturnType>("command_name", { args })`
- Rust events emitted to frontend: `scan-progress`, `comic-indexed`, `scan-complete`, `cache-cleared`
- Frontend listens via `listen<PayloadType>("event-name", callback)`

### Database (SQLite via rusqlite)
- `config` table: KV store (`library_path`, etc.)
- `comics` table: indexed comic files with `file_hash` (blake3) for change detection
- `comic_pages` table: per-comic page listing, FK→comics with CASCADE delete
- WAL mode enabled for read concurrency

### Scanning (scanner.rs)
- Walks library directory for `.zip`/`.cbz` files
- Parallel hash computation via rayon
- Incremental: compares `file_hash` to skip unchanged, re-index changed, remove deleted
- Emits `scan-progress` per file, `comic-indexed` per new comic, `scan-complete` on finish

### Caching
- Thumbnails: WebP covers in `{app_data}/cache/{library_hash}/thumbnails/`
- Page cache: `{app_data}/cache/{library_hash}/pages/`
- Library hash: first 16 hex chars of blake3(library_path)
- Cache isolation: each library directory gets its own cache subdirectory

## Commands (Rust → TS)

| Command | Args | Returns |
|---------|------|---------|
| `get_library_path` | — | `string \| null` |
| `set_library_path` | `path: string` | `ScanResult` |
| `scan_library` | — | `ScanResult` |
| `get_comics` | — | `ComicInfo[]` |
| `get_comic_pages` | `comicId: number` | `PageInfo[]` |
| `get_cover_file_path` | `comicId: number` | `string \| null` |
| `get_page_file_path` | `comicId, pageIdx` | `string \| null` |
| `open_file_location` | `path: string` | — |
| `delete_comic` | `comicId, deleteLocalFile` | — |
| `get_app_paths` | — | `AppPaths` |
| `clear_current_cache` | — | `ClearCacheResult` |
| `clear_all_cache` | — | `ClearCacheResult` |
| `get_cache_sizes` | — | `CacheSizes` |

## UI Patterns

### Dialogs & Popovers
- Settings dialog: sidebar layout, rendered via `createPortal` to `document.body`
- Delete confirmation dialog: also portal to body
- Confirm popover (clear all cache): portal to body, `position: fixed`, tracks anchor button via `getBoundingClientRect()` + scroll listener on `.settings-content`; auto-closes when button scrolls out of dialog bounds
- Context menu: portal to body, positioned at `clientX`/`clientY`

### Search
- Simple case-insensitive substring match (`indexOf`), not fuzzy
- Highlights all occurrences in ComicCard using `<mark>` elements
- `HighlightRange` type: `readonly number[]` (inclusive [start, end] indices)
- Ranges are merged (overlap/adjacent) before rendering

### Virtual Scrolling
- `@tanstack/react-virtual` for both library grid and reader
- Grid: responsive columns calculated from container width, fixed card size (200×300 + 16px gap)
- Reader: vertical stack, preloads next 3 pages

## Development

```bash
pnpm dev                    # Vite dev server
pnpm run tauri dev          # Tauri dev mode (app window)
pnpm run tauri build        # Release build (--no-bundle to skip installer)
npx tsc --noEmit            # TypeScript type-check (zero errors expected)
```

## Build Notes
- Tauri v2: `build` is release by default, no `--release` flag
- MSI bundling requires WiX Toolset in `%APPDATA%/tauri/WixTools/`; use `--no-bundle` to skip
- Rust dependencies: `image` needs `webp` feature; `rusqlite` uses `bundled` feature

## CSS
- All styles in `App.css`, no CSS modules or inline styles (except dynamic positioning)
- CSS variables in `:root` for theming: `--bg`, `--bg-card`, `--text`, `--text-secondary`, `--accent`, `--border`, `--border-color`
- Custom scrollbar styles for settings dialog and other scrollable areas
- Z-index layers: toolbar logo 10, context menu 1000, dialog overlay 2000, confirm popover 2001
