# CLAUDE.md

A Tauri v2 desktop comic reader for ZIP/CBZ files. Dark-theme UI with virtual-scroll library grid and vertical-scroll reader (webtoon style).

## Project Structure

```
comic-dev/
├── src/                        # React frontend (TypeScript)
│   ├── main.tsx                # React entry point
│   ├── App.tsx                 # Top-level layout: Toolbar + view switcher (library | reader)
│   ├── App.css                 # All styles (CSS variables, dark theme)
│   ├── vite-env.d.ts           # Vite type declarations
│   ├── types/index.ts          # Shared TypeScript interfaces (mirror Rust models)
│   ├── store/useAppStore.ts    # Zustand store — single source of truth for UI state
│   └── components/
│       ├── Toolbar.tsx         # Directory picker, scan button, search, progress bar, settings trigger
│       ├── LibraryView.tsx     # Virtual-scroll grid of comic cards; context menu + delete dialog
│       ├── ComicCard.tsx       # Single cover card with search highlighting
│       ├── ReaderView.tsx      # Scroll-based reader with lazy page extraction + keyboard nav
│       └── SettingsDialog.tsx  # Storage management (cache sizes, clear buttons) + about tab
├── src-tauri/
│   ├── Cargo.toml              # Rust dependencies
│   ├── tauri.conf.json         # Tauri v2 config (window, CSP, asset protocol, bundle)
│   ├── capabilities/           # Tauri v2 permissions (auto-generated)
│   └── src/
│       ├── main.rs             # Windows subsystem + run()
│       ├── lib.rs              # App setup: DB init, r2d2 pool (max 6), state registration, command handlers
│       ├── commands.rs         # All #[tauri::command] functions (14 commands)
│       ├── db.rs               # SQLite schema + CRUD operations (comics, pages, config)
│       ├── models.rs           # Rust structs (ComicInfo, PageInfo, ScanResult, ScanProgress, etc.)
│       ├── scanner.rs          # Library scanner: file discovery → hashing → ZIP extraction → thumbnail → DB write
│       └── thumbnail.rs        # WebP thumbnail generation (lossy, quality 85, 200px wide, Lanczos3)
├── package.json                # Node dependencies + scripts
├── tsconfig.json               # TypeScript config
├── vite.config.ts              # Vite config (Tauri focused, port 1420)
└── index.html                  # Vite entry HTML
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop framework | Tauri v2 |
| Frontend | React 19, TypeScript 5.8, Vite 7 |
| State management | Zustand 5 |
| Virtual scroll | @tanstack/react-virtual 3 |
| Data fetching | @tanstack/react-query 5 (imported, minimal use) |
| Styling | Plain CSS (no framework) — dark theme with CSS variables |
| Backend | Rust (edition 2021) |
| Database | SQLite via rusqlite 0.37 + r2d2 connection pool |
| Parallelism | rayon 1.10 (parallel scan + thumbnail generation) |
| Image processing | `image` crate 0.25 (decode) + `webp` crate 0.3 (lossy encode) |
| Hashing | blake3 (partial-file hash: first 64KB + last 64KB + size) |
| ZIP handling | `zip` crate 2.2 |
| Tauri plugins | opener, fs, dialog |

## Architecture Patterns

### State: Zustand (single store)

All UI state lives in [src/store/useAppStore.ts](src/store/useAppStore.ts):
- **Library state**: `libraryPath`, `comics[]`, `scanResult`, `scanProgress`, `isScanning`, `searchQuery`
- **Reader state**: `currentView` ("library" | "reader"), `currentComicId`
- Selector pattern: subscribe to individual slices (`useAppStore((s) => s.comics)`) to avoid unnecessary re-renders
- `upsertComic` and `batchUpsertComics` for real-time scan updates; maintain sorted order by `fileName` with natural sort (`numeric: true, sensitivity: "base"`)

### IPC: Commands + Events

**Commands** (invoked from frontend via `@tauri-apps/api/core`):
- `get_library_path` → `Option<String>`
- `set_library_path(path)` → `ScanResult` (triggers full scan)
- `scan_library` → `ScanResult` (re-scan current library)
- `get_comics` → `Vec<ComicInfo>` (with `cover_file_path` populated)
- `get_comic_pages(comic_id)` → `Vec<PageInfo>`
- `get_page_file_path(comic_id, page_idx)` → `String` (extracts from ZIP on first access, caches to disk)
- `get_cover_file_path(comic_id)` → `String`
- `open_file_location(path)` → cross-platform "show in file manager"
- `delete_comic(comic_id, delete_local_file)` → removes DB record + cached files
- `get_app_paths` / `get_cache_sizes` / `clear_*_cache` → cache management

**Events** (emitted Rust → JS, listened via `@tauri-apps/api/event`):
- `scan-progress` — per-file during scan (throttled to rAF on frontend)
- `comic-indexed` — per-comic as scan completes (batched in 100ms windows on frontend)
- `scan-complete` — scan finished → triggers full `get_comics` refresh (handles removals)
- `cache-cleared` — when any cache is cleared → frontend refreshes comic list

### Database: SQLite with r2d2 pool

- DB file: `{app_data_dir}/comics.db` (app data dir varies by OS)
- WAL mode enabled for concurrent reads
- Pool size: max 6 connections; each has `busy_timeout = 5000ms`
- Tables: `config` (key-value), `comics`, `comic_pages` (FK → comics with CASCADE delete)
- **Critical pattern**: Pool connections are held **briefly** (DB queries only). Long I/O (ZIP extraction, thumbnail generation) happens **without** a pool connection held. See `get_page_file_path` and scanner phase 3.

### Scanning Pipeline (Rayon parallel)

1. **Phase 1**: Walk directory tree → discover .zip/.cbz files → compute blake3 hashes in parallel
2. **Phase 2**: Get current DB state (file paths set)
3. **Phase 3**: For each file (parallel for_each):
   a. Pool get → check hash + page_count (re-index if hash changed or page_count == 0)
   b. Pool get → insert/update comic record → get comic_id
   c. No pool → open ZIP, list image entries (sorted by natural sort), generate WebP thumbnail from first image
   d. Pool get → save pages + update page_count + set cover_path
4. **Phase 4**: Remove comics whose files no longer exist on disk

### Cover Images

- Thumbnails generated during scan: first image from ZIP → decode → resize (200px wide, Lanczos3) → lossy WebP (quality 85)
- Stored at `{cache_root}/{library_hash_16}/thumbnails/{comic_id}.webp`
- Loaded via Tauri's `convertFileSrc()` (asset protocol) — requires `assetProtocol: { enable: true, scope: ["**"] }`

### Virtual Scroll (Library & Reader)

Both views use `@tanstack/react-virtual`:
- **Library**: Grid layout with fixed card size (200×300px + 16px gap); calculates columns from container width
- **Reader**: Vertical scroll with dynamic-height pages (measured via `measureElement`); uses shared `OVERSCAN` constant (currently 3) for both virtualizer config and preload window, guaranteeing the fetch window fully covers rendered DOM nodes
  - **overscan** — how many extra rows are rendered as DOM (avoids white flash on scroll)
  - **preload** — how far ahead to trigger `get_page_file_path` (ZIP extraction + disk cache)
  - Page images extracted lazily from ZIP on first access and cached to `{cache_root}/{library_hash_16}/pages/{comic_id}/{page_idx}.{ext}`; second read is instant (disk cache hit, no ZIP open)

### Reader: Page Extraction Model

Lazy, single-page extraction via `get_page_file_path(comic_id, page_idx)`:
1. Check disk cache → if exists, return path immediately (~1ms)
2. DB lookup (pool held briefly) → get comic ZIP path + page filename
3. **No pool** → open ZIP, `by_name` lookup, decompress, write to disk cache
4. Return cached file path → frontend calls `convertFileSrc()` for asset protocol URL

The bottleneck is step 3's decompression (10–100ms per page, dominated by image size). ZIP open/close overhead is negligible on SSDs (~1ms). Disk cache means every page is only extracted once per comic lifetime.

### Cache Isolation

Each library directory gets a scoped cache using blake3 hash (first 16 hex chars):
- `{cache_root}/{hash}/thumbnails/` — cover thumbnails
- `{cache_root}/{hash}/pages/` — extracted page images

## Commands

```bash
pnpm dev          # Start Vite dev server (port 1420)
pnpm build        # TypeScript check + Vite production build
pnpm tauri dev    # Start Tauri dev (launches desktop app with hot-reload)
pnpm tauri build  # Production Tauri build
```

## Key Conventions

- **Composition API + hooks**: React functional components with Zustand hooks (not Options API — this is React, not Vue despite the skill list)
- **TypeScript types** in [src/types/index.ts](src/types/index.ts) mirror Rust structs in [src-tauri/src/models.rs](src-tauri/src/models.rs) — keep `#[serde(rename_all = "camelCase")]` in sync
- **CSS**: All styles in single [src/App.css](src/App.css) — dark theme with CSS variables (`--bg-primary`, `--accent`, etc.)
- **Portal dialogs**: Context menus, delete confirmations, and settings are rendered to `document.body` via `createPortal` to avoid CSS containment issues from virtual scroll transforms
- **Chinese UI**: User-facing text mixes English and Chinese (搜索, 漫画, 设置, 删除, etc.)
- **Thumbnail dedup**: `get_comic_hash_and_page_count` checks both hash AND page_count — page_count == 0 means a previous scan was interrupted, forcing re-extraction even if hash matches
- **Natural sort**: Custom `natural_cmp` in scanner for page ordering (handles numeric segments in filenames)
- **`#[cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`** in main.rs — do NOT remove, suppresses console window on Windows release builds
