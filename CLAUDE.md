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
  vite.config.ts                 outDir: ../src-tauri/web-dist/

src/                           ── Desktop Tauri frontend (Vite + React)
  main.tsx                       Entry — BrowserRouter + i18n init
  App.tsx                        Layout: Toolbar + Routes
  components/Toolbar.tsx         Dir picker, scan, search, LAN share w/ QR, settings
  components/LibraryView.tsx     Virtual-scrolled comic grid with context menu + delete dialog
  components/ReaderView.tsx      Lazy page extraction via get_page_file_path, virtual scroll
  components/ComicCard.tsx       Cover thumbnail card with search highlight
  components/SettingsDialog.tsx  Tabs: General (language switch) / Storage (cache mgmt) / About
  store/useAppStore.ts           Zustand store — comics, scan state, search, language
  types/index.ts                 TypeScript mirror of Rust model structs
  i18n.ts                        react-i18next init (LanguageDetector: localStorage → navigator)
  locales/*/translation.json     60+ desktop UI keys

src-tauri/                     ── Rust backend (Tauri + Axum)
  Cargo.toml                     Dependencies: tauri 2, rusqlite (bundled), rayon, axum, zip, image, blake3
  src/main.rs                    Entry — delegates to lib::run
  src/lib.rs                     Tauri builder: plugins, DB init, r2d2 pool, 20 command handlers
  src/commands.rs                All #[tauri::command] functions + LAN server start/stop
  src/db.rs                      SQLite schema + CRUD (config, comics, pages)
  src/models.rs                  Serde structs: ComicInfo, PageInfo, ScanResult, CacheSizes, ServerInfo…
  src/scanner.rs                 Parallel library scanner: discover → hash → index → thumbnail (rayon)
  src/server.rs                  Axum HTTP server for LAN sharing: /api/comics, /api/image/*
  src/thumbnail.rs               WebP thumbnail generation from ZIP entries (image + webp crates)
  tauri.conf.json                beforeDevCommand: pnpm build:web && pnpm dev
  capabilities/default.json      Permissions: core, opener, fs, dialog

pnpm-workspace.yaml             Root workspace links web/
package.json                    Root scripts: build:web, build, tauri
```

## Three Build Targets

| Target | Technology | Entry | Output |
|--------|-----------|-------|--------|
| Desktop UI | React + Tauri IPC (`invoke`) | `src/main.tsx` | `dist/` (Vite) |
| Web SPA (mobile) | React + HTTP fetch | `web/src/main.tsx` | `src-tauri/web-dist/` |
| Rust backend | Tauri v2 + Axum | `src-tauri/src/lib.rs` | Cargo target |

## Key Data Flow

### Startup (Desktop)
```
lib.rs::run() → init_db() → create r2d2 pool
  → LibraryView mounts → invoke("get_library_path") + invoke("get_comics")
  → Zustand store populates → virtual grid renders with WebP thumbnails (convertFileSrc)
```

### Scanning
```
Toolbar → invoke("set_library_path"/"scan_library")
  → scanner.rs::scan_library() ── 4-phase parallel pipeline:
    1. WalkDir discover ZIP/CBZ files
    2. Rayon parallel blake3 hash (first+last 64KB + size)
    3. Rayon parallel: check DB → insert/update → open ZIP → extract pages + generate WebP thumbnail
    4. Remove stale DB entries not found on disk
  → emits "scan-progress" (per-file) + "comic-indexed" (per-new/updated comic) + "scan-complete"
  → LibraryView listens, upserts comics into Zustand in 100ms batches
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
  → Axum serves: /api/comics, /api/comics/{id}/pages, /api/image/cover/{id}, /api/image/page/{id}/{idx}
  → Static files from web-dist/ (React SPA)
  → QR code generated in frontend (qrcode lib)
  → URL includes ?lang= parameter for mobile language
  → Mobile reads ?lang= from URL params, no independent toggle
```

### Mobile Web
```
Phone browser → http://192.168.1.x:9527?lang=zh
  → Axum serves web-dist/ SPA (BrowserRouter)
  → Library.tsx: fetch("/api/comics") → virtual grid
  → Reader.tsx: fetch("/api/image/page/{id}/{idx}") — server-side ZIP extract on demand
```

## SQLite Schema

Three tables in `{app_data}/comics.db` with WAL mode:

- **config** — key-value store (`key PRIMARY KEY`, `value`). Used for `library_path`, `language`
- **comics** — comic metadata (`id`, `file_path UNIQUE`, `file_name`, `file_hash`, `file_size`, `page_count`, `cover_path`, `added_at`, `updated_at`). Index on `file_path`
- **comic_pages** — per-comic page listing (`id`, `comic_id FK CASCADE`, `page_idx`, `file_name`, `file_size`). Unique on `(comic_id, page_idx)`. Index on `comic_id`

Per-library cache: `{app_data}/cache/{hash_prefix}/`. Hash = `blake3(library_path)[..16]` hex.
- `thumbnails/{comic_id}.webp` — lossy WebP, width 200px
- `pages/{comic_id}/{page_idx}.{ext}` — extracted on first access

## Rust Backend Patterns

- **r2d2 pool** (max 6 connections) — avoids Mutex contention. Each connection sets `busy_timeout=5000` + `foreign_keys=ON`
- **Phase-separated DB access** — pool connections held briefly for queries, released before heavy I/O (ZIP decompress, image processing). Commands like `get_page_file_path` and scanner use this pattern
- **Rayon parallelism** — scanner uses `par_iter()` for file hashing and ZIP processing. Each rayon task borrows its own pool connection
- **Events** — frontend listens to `scan-progress`, `comic-indexed`, `scan-complete`, `language-changed`, `cache-cleared`
- **Graceful shutdown** — HTTP server uses `tokio::sync::oneshot` channel for clean shutdown

## i18n Architecture

- **Desktop**: `react-i18next` with `i18next-browser-languagedetector`. Detection order: `localStorage → navigator.language`. Fallback: `zh`. Language persisted in SQLite `config` table via `get_language`/`set_language` commands. Multi-window sync via `language-changed` event
- **Web**: Same react-i18next stack, but language read from URL `?lang=` param (set by desktop share URL). No independent toggle
- **Locale files**: Desktop `src/locales/{zh,en}/translation.json` (60+ keys). Web `web/src/locales/{zh,en}/translation.json` (~20 keys, namespaced under `web.*`)

## Important Conventions

1. **Tauri commands** — 20 commands registered in `lib.rs`. Command file is `commands.rs`. New commands must be added to both `invoke_handler!` macro and `capabilities/default.json` permissions
2. **DB pool** — never hold a pool connection across I/O boundaries. Always `{ let conn = pool.get()?; ...; }` (block scope releases borrow)
3. **Virtual scrolling** — both desktop and web use `@tanstack/react-virtual` with `measureElement` for dynamic height. Library uses fixed-size grid rows; Reader uses dynamic image heights
4. **Serialization** — Rust structs use `#[serde(rename_all = "camelCase")]` to match JS camelCase convention. TypeScript types in `src/types/index.ts` and `web/src/api.ts` mirror Rust models
5. **Thumbnails** — generated at scan time (not request time). WebP lossy quality 85, 200px width. **Never create thumbnails during ZIP reading** — use `thumbnail::generate_thumbnail_from_bytes()`
6. **No `eprintln!`** — server.rs uses proper error types (AppError enum with IntoResponse). Debug output in scanner uses `eprintln!` only for non-recoverable hash errors
7. **pnpm workspace** — root has `web/` in workspace. Root scripts delegate: `build:web` → `cd web && pnpm build`, `build` → `build:web && desktop build`, `tauri` → `build:web && tauri`
