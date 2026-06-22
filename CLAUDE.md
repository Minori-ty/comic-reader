# Comic Reader — Tauri v2 + Rust + React

Local comic/manga reader that scans directories of ZIP/CBZ files, indexes them in SQLite, generates WebP cover thumbnails, and reads pages from ZIPs via extract-to-disk cache + convertFileSrc.

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
└── thumbnail.rs              # WebP cover thumbnail generation
```

## Key Architecture

### State Management
- **Zustand** store (`useAppStore.ts`) — single source of truth
- State shape: `libraryPath`, `comics[]`, `searchQuery`, `scanResult`, `scanProgress`, `isScanning`, `currentView`, `currentComicId`
- Actions: `setComics`, `upsertComic` (single insert), `batchUpsertComics` (bulk insert — one array copy, one sort, one render), `openReader`, `goToLibrary`, etc.

### IPC Pattern
- Frontend calls Rust via `invoke<ReturnType>("command_name", { args })`
- Rust events emitted to frontend: `scan-progress`, `comic-indexed`, `scan-complete`, `cache-cleared`
- Frontend listens via `listen<PayloadType>("event-name", callback)`

### Database (SQLite via rusqlite + r2d2)
- `config` table: KV store (`library_path`, etc.)
- `comics` table: indexed comic files with `file_hash` (blake3) for change detection
- `comic_pages` table: per-comic page listing, FK→comics with CASCADE delete
- WAL mode enabled for read concurrency
- **Connection pool** (`r2d2` + `r2d2_sqlite`) replaces single `Mutex<Connection>`. Up to 6 concurrent connections; `busy_timeout=5000` so writers wait instead of failing with SQLITE_BUSY.
- `DbPool` type alias in `commands.rs`: `r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>`
- Per-connection pragmas (`foreign_keys`, `busy_timeout`) set via `with_init` on the pool manager
- `db::init_db` sets WAL mode and creates tables once at startup, then returns `()` — pool handles subsequent connections

### Scanning (scanner.rs)
- Walks library directory for `.zip`/`.cbz` files
- Parallel hash computation via rayon
- Incremental: compares `file_hash` to skip unchanged, re-index changed, remove deleted
- Uses r2d2 pool (`&DbPool`) — each rayon task checks out a connection briefly for DB operations, releases it for heavy I/O
- Emits `scan-progress` per file, `comic-indexed` per new comic, `scan-complete` on finish
- **Frontend throttling:** `scan-progress` is rAF-throttled in Toolbar; `comic-indexed` events are batched in 100 ms windows and applied via `batchUpsertComics` (single array copy → single render)

### Caching
- Thumbnails: WebP covers in `{app_data}/cache/{library_hash}/thumbnails/`
- Page cache: `{app_data}/cache/{library_hash}/pages/`
- Library hash: first 16 hex chars of blake3(library_path)
- Cache isolation: each library directory gets its own cache subdirectory
- **Fine-grained clear:** `clear_thumbnails_cache` (resets `cover_path` in DB), `clear_pages_cache` (keeps DB metadata), `clear_current_cache` (both + DB records), `clear_all_cache` (all libraries + full DB wipe)

### Page Extraction
- `get_page_file_path` releases its pool connection **before** ZIP extraction. DB lookups happen in a brief guarded scope; decompression and disk write run without holding a connection, so concurrent commands (library refresh, search) are never blocked.

### Thumbnails
- Lossy WebP at quality 85 via `webp` crate — 3-5× faster than lossless, visually identical at 200px

### Build-time Config
- `build.rs` reads `identifier` from `tauri.conf.json` at compile time and exports it as `APP_IDENTIFIER` env var, consumed in `lib.rs` via `env!("APP_IDENTIFIER")` — no hardcoded duplicate

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
| `clear_thumbnails_cache` | — | `ClearCacheResult` |
| `clear_pages_cache` | — | `ClearCacheResult` |
| `clear_current_cache` | — | `ClearCacheResult` |
| `clear_all_cache` | — | `ClearCacheResult` |
| `get_cache_sizes` | — | `CacheSizes` |

## UI Patterns

### Dialogs & Popovers
- Settings dialog: sidebar layout, rendered via `createPortal` to `document.body`
- Delete confirmation dialog: also portal to body
- Confirm popover (clear all cache): rendered **inline** inside a `position: relative` wrapper (`.settings-popover-anchor`) around the trigger button. Uses `position: absolute; bottom: calc(100% + 10px)` — no portal, no JS position calculation, no z-index. Scrolls naturally with the settings content and is clipped by `overflow-y: auto`. Only JS is click-outside + Escape to dismiss.
- Context menu: portal to body, positioned at `clientX`/`clientY`
- Toast notifications: portal to body, `position: fixed` at top-center, auto-dismiss via `useEffect` timer (3s), slide-in animation (`@keyframes toast-in`)

### Search
- Simple case-insensitive substring match (`indexOf`), not fuzzy
- Highlights all occurrences in ComicCard using `<mark>` elements
- `HighlightRange` type: `readonly number[]` (inclusive [start, end] indices)
- Ranges are merged (overlap/adjacent) before rendering

### Loading States
- Initial scan from empty library: full-area spinner (`.library-loading`) shown when `isScanning && comics.length === 0`, disappears once the first `comic-indexed` event adds a comic to the list
- `"No Comics Found"` only renders when scanning is complete and the list is still empty

### Virtual Scrolling
- `@tanstack/react-virtual` for both library grid and reader
- Grid: responsive columns calculated from container width, fixed card size (200×300 + 16px gap)
- Reader: virtualized vertical stack, `estimateSize` based on viewport height. Only visible pages + 3 overscan are rendered in the DOM. Page images are **extracted lazily** — `get_page_file_path` is called on demand when a page scrolls into the preload window (2 pages before/after visible range), so opening a 200-page comic only extracts ~5 pages upfront instead of all 200.

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
- Rust dependencies: `image` needs `webp` feature; `rusqlite` uses `bundled` feature; `webp` crate (0.3) for lossy thumbnail encoding; `r2d2` + `r2d2_sqlite` for connection pooling

## CSS
- All styles in `App.css`, no CSS modules or inline styles (except dynamic positioning)
- CSS variables in `:root` for theming: `--bg-primary`, `--bg-secondary`, `--bg-card`, `--bg-hover`, `--text-primary`, `--text-secondary`, `--accent`, `--accent-hover`, `--border`, `--toolbar-height`, `--reader-header-height`
- Custom scrollbar styles for settings dialog and other scrollable areas
- Z-index layers: toolbar logo 10, context menu 1000, dialog overlay 2000, toast 10000
