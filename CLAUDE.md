# Comic Reader — Architecture Overview

A high-performance local comic reader built with **Tauri v2** (Rust backend) + **React 19** (TypeScript frontend).
Supports ZIP/CBZ comics with cover thumbnails, virtual-scrolled reading, and LAN sharing with QR code.

## Repository Layout

```
web/                           ── Mobile Web SPA (Vite + React)
  src/pages/Library.tsx          Virtual-scrolled comic grid, reads from LAN server API
  src/pages/Reader.tsx           Vertical scroll reader, page images from API
  src/api.ts                     Fetch wrappers: /api/comics, /api/image/*
  src/locales/*/translation.json  UI strings for zh/en
  src/i18n.ts                    LanguageDetector: navigator.language, cache disabled
  vite.config.ts                 outDir: ../src-tauri/web-dist/

src/                           ── Desktop Tauri frontend (Vite + React)
  main.tsx                       Entry — BrowserRouter + i18n init
  App.tsx                        Layout: Toolbar + Routes; loads language from Rust on startup
  components/Toolbar.tsx         Dir picker, scan, search, LAN share w/ QR, settings
  components/LibraryView.tsx     Virtual-scrolled comic grid with context menu + delete dialog
  components/ReaderView.tsx      Lazy page extraction via get_page_file_path, virtual scroll
  components/ComicCard.tsx       Cover thumbnail card with search highlight
  components/SettingsDialog.tsx  Tabs: General (<select> language) / Storage (cache mgmt) / About
  store/useAppStore.ts           Zustand store — comics, scan state, search, server state
  types/index.ts                 TypeScript mirror of Rust model structs
  i18n.ts                        react-i18next — Rust backend is source of truth for language
  locales/*/translation.json     60+ desktop UI keys

src-tauri/                     ── Rust backend (Tauri + Axum)
  Cargo.toml                     Dependencies: tauri 2, rusqlite (bundled), rayon, axum 0.8, zip, image, blake3, mime_guess, sys-locale
  src/main.rs                    Entry — delegates to lib::run
  src/lib.rs                     Tauri builder: plugins, DB init, r2d2 pool (dynamic size), 20 command handlers
  src/commands.rs                All #[tauri::command] functions + LAN server start/stop; library_cache_dir is pub(crate)
  src/db.rs                      SQLite schema + CRUD (config, comics, pages)
  src/models.rs                  Serde structs: ComicInfo, PageInfo, ScanResult, CacheSizes, ServerInfo…
  src/scanner.rs                 Parallel library scanner: discover → get DB paths → per-file hash+ZIP+thumbnail (rayon) → cleanup
  src/server.rs                  Axum HTTP server: explicit routes with typed extractors, mime_guess for MIME, library_cache_dir shared
  src/thumbnail.rs               WebP thumbnail generation from ZIP entries (Triangle filter, quality 85); pub IMAGE_EXTENSIONS
  tauri.conf.json                beforeDevCommand: pnpm build:web && pnpm dev
  capabilities/default.json      Permissions: core, opener, fs, dialog

pnpm-workspace.yaml             Root workspace links web/
package.json                    Root scripts: build:web, build, tauri
```

## Three Build Targets

| Target           | Technology                   | Entry                  | Output                |
| ---------------- | ---------------------------- | ---------------------- | --------------------- |
| Desktop UI       | React + Tauri IPC (`invoke`) | `src/main.tsx`         | `dist/` (Vite)        |
| Web SPA (mobile) | React + HTTP fetch           | `web/src/main.tsx`     | `src-tauri/web-dist/` |
| Rust backend     | Tauri v2 + Axum              | `src-tauri/src/lib.rs` | Cargo target          |

## Key Data Flow

### Startup (Desktop)

```
lib.rs::run() → init_db() → create r2d2 pool (dynamic: available_parallelism().max(8))
  → App.tsx mounts → invoke("get_language") → i18n.changeLanguage()
  → LibraryView mounts → invoke("get_library_path") + invoke("get_comics")
  → Zustand store populates → virtual grid renders with WebP thumbnails (convertFileSrc)
```

### Scanning

```
Toolbar → invoke("set_library_path"/"scan_library")
  → scanner.rs::scan_library() ── 4-phase parallel pipeline:
    1. WalkDir discover ZIP/CBZ files
    2. Get current DB paths (single query)
    3. Rayon parallel per-file: blake3 hash → DB check → insert/update → ZIP extract
       (O(N) by_index single pass) → Triangle WebP thumbnail → emit "comic-indexed"
    4. Remove stale DB entries not found on disk
  → emits "scan-progress" (per-file) + "comic-indexed" (per-new/updated comic) + "scan-complete"
  → LibraryView listens, upserts comics into Zustand in 100ms batches

  Hash is now computed inside the per-file phase (not a global barrier), so
  "comic-indexed" fires as soon as the first file finishes — within seconds,
  not after ALL files have been hashed.
```

### Reading (Desktop)

```
ReaderView mounts → invoke("get_comic_pages") for metadata (fast, DB only)
  → Virtual scroll renders visible range
  → Each visible page calls invoke("get_page_file_path") — lazy extract from ZIP to cache
  → convertFileSrc() for asset:// protocol display
  Image key: src-tauri/src/commands.rs phase-separated (DB lookup → release pool → ZIP extract)
```

### LAN Sharing

```
Toolbar → invoke("start_server", {port: 9527})
  → commands.rs spawns tokio task with server::run()
  → Axum serves explicit routes:
      GET  /api/comics                → list_comics
      GET  /api/comics/{id}/pages     → list_pages
      GET  /api/image/cover/{comic_id} → serve_cover
      GET  /api/image/page/{comic_id}/{page_idx} → serve_page
      GET/POST /api/config/language   → get_language / set_language
  → Static files from web-dist/ (React SPA)
  → QR code generated in frontend (qrcode lib), no ?lang= suffix
```

### Mobile Web

```
Phone browser → http://192.168.1.x:9527
  → Axum serves web-dist/ SPA (BrowserRouter)
  → LanguageDetector detects from navigator.language, no caching (caches: [])
  → Library.tsx: fetch("/api/comics") → virtual grid
  → Reader.tsx: fetch("/api/image/page/{id}/{idx}") — server-side ZIP extract on demand
```

## SQLite Schema

Three tables in `{app_data}/comics.db` with WAL mode:

- **config** — key-value store (`key PRIMARY KEY`, `value`). Used for `library_path`, `language`
- **comics** — comic metadata (`id`, `file_path UNIQUE`, `file_name`, `file_hash`, `file_size`, `page_count`, `cover_path`, `added_at`, `updated_at`). Index on `file_path`
- **comic_pages** — per-comic page listing (`id`, `comic_id FK CASCADE`, `page_idx`, `file_name`, `file_size`). Unique on `(comic_id, page_idx)`. Index on `comic_id`

Per-library cache: `{app_data}/cache/{hash_prefix}/`. Hash = `blake3(library_path)[..16]` hex.

- `thumbnails/{comic_id}.webp` — lossy WebP, width 200px, Triangle filter
- `pages/{comic_id}/{page_idx}.{ext}` — extracted on first access

## Rust Backend Patterns

- **r2d2 pool** — dynamic size `available_parallelism().max(8)`. Each connection sets `busy_timeout=5000` + `foreign_keys=ON`
- **Phase-separated DB access** — pool connections held briefly for queries, released before heavy I/O (ZIP decompress, image processing). Scanner merges hash-check + insert/update into one pool.get() (3→2 gets per file), then wraps page inserts in a single SQLite transaction (1 fsync instead of N)
- **Rayon parallelism** — scanner uses `par_iter()` for per-file processing (hash + ZIP + thumbnail). Each rayon task borrows its own pool connection. No global hash barrier — first comic appears within seconds
- **Events** — frontend listens to `scan-progress`, `comic-indexed`, `scan-complete`, `language-changed`, `cache-cleared`
- **Graceful shutdown** — HTTP server uses `tokio::sync::oneshot` channel for clean shutdown

## Server (Axum)

- **Explicit routes** with typed extractors: `Path<i64>`, `Path<PagePath>`, `Json<SetLanguageRequest>`, `State<Arc<ShareState>>`
- **mime_guess** — `mime_guess::from_ext(ext).first_or_octet_stream()` replaces manual MIME map
- **Dedup** — `library_cache_dir` is `pub(crate)` in `commands.rs`; server imports it via `crate::commands::library_cache_dir`
- **IMAGE_EXTENSIONS** — `crate::thumbnail::IMAGE_EXTENSIONS` is the single source of truth for image extension filtering

## i18n Architecture

- **Desktop**: Language is managed by the Rust backend. `get_language` detects system locale via `sys_locale::get_locale()` on first launch (starts-with "zh" → zh, else en) and persists to SQLite. `set_language` emits `language-changed` event for multi-window sync. Frontend `App.tsx` calls `invoke("get_language")` on startup. Settings dialog uses a `<select>` dropdown (not buttons). No browser LanguageDetector — Rust is the sole source of truth.
- **Web**: Uses `LanguageDetector` with order `['localStorage', 'navigator']` and `caches: []` (no caching). Every page load reads `navigator.language` fresh — follows browser language naturally. No `?lang=` URL parameter. No manual language toggle on web side.
- **Locale files**: Desktop `src/locales/{zh,en}/translation.json` (60+ keys). Web `web/src/locales/{zh,en}/translation.json` (~20 keys, namespaced under `web.*`)

## Web Scrollbar Styles

Both `.lib-scroll` and `.reader-scroll` custom scrollbar styles are wrapped in `@media (pointer: fine)`:

- **Desktop (mouse)**: 8px custom scrollbar with theme colors
- **Mobile/tablet (touch)**: native scrollbar, no override

## Important Conventions

1. **Tauri commands** — 20 commands registered in `lib.rs`. Command file is `commands.rs`. New commands must be added to both `invoke_handler!` macro and `capabilities/default.json` permissions
2. **DB pool** — never hold a pool connection across I/O boundaries. Always `{ let conn = pool.get()?; ...; }` (block scope releases borrow). Pool size is dynamic: `available_parallelism().max(8)` — scales with CPU cores
3. **Virtual scrolling** — both desktop and web use `@tanstack/react-virtual` with `measureElement` for dynamic height. Library uses fixed-size grid rows; Reader uses dynamic image heights
4. **Serialization** — Rust structs use `#[serde(rename_all = "camelCase")]` to match JS camelCase convention. TypeScript types in `src/types/index.ts` and `web/src/api.ts` mirror Rust models
5. **Thumbnails** — generated at scan time (not request time). WebP lossy quality 85, 200px width, Triangle filter. **Never create thumbnails during ZIP reading** — use `thumbnail::generate_thumbnail_from_bytes()`
6. **No `eprintln!`** — server.rs uses proper error types (AppError enum with IntoResponse). Debug output in scanner uses `eprintln!` only for non-recoverable hash errors
7. **pnpm workspace** — root has `web/` in workspace. Root scripts delegate: `build:web` → `cd web && pnpm build`, `build` → `build:web && desktop build`, `tauri` → `build:web && tauri`
8. **ZIP scanning** — `process_comic_assets` uses `by_index()` single O(N) pass to collect image names+sizes. Never call `by_name()` in a loop — it does an internal linear scan, leading to O(N²)
9. **Scanner DB writes** — per-comic page inserts are wrapped in a single `BEGIN/COMMIT` transaction. Avoids per-row implicit transactions and the resulting per-row fsync overhead
