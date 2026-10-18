# Comic Reader

[English](./README.md) · [中文](./README.zh-CN.md)

A high-performance local comic reader built with Tauri v2 (Rust backend) and React 19 (TypeScript frontend). It supports ZIP/CBZ comics with cover thumbnails, virtual-scrolled reading, and LAN sharing.

## Highlights
- Desktop app: Tauri (Rust) + React 19 + TypeScript
- Web SPA: Vite + React — mobile-optimized reader using the same backend API
- Fast local library scanning with parallel processing and deduplication
- WebP cover thumbnails generated from archive entries
- Virtual-scrolled reader with lazy page extraction for low memory use
- LAN sharing via a built-in HTTP server with a QR code for quick device access
- SQLite persistence with a pooled database connection

## Architecture at a glance
- Frontend (desktop)
  - Location: src/
  - Entry: src/main.tsx
  - Key components:
    - src/components/Toolbar.tsx — directory picker, scan, search, LAN share/QR, settings
    - src/components/LibraryView.tsx — virtual-scrolled grid, context menu, delete dialog
    - src/components/ReaderView.tsx — vertical reader with virtual scroll and lazy page loading
  - State: src/store/useAppStore.ts (Zustand)
  - Types: src/types/

- Web SPA (mobile)
  - Location: web/
  - Entry: web/src/main.tsx
  - Uses HTTP fetch to the backend API (for example: /api/comics and /api/image/*)
  - Built web assets are consumed by the desktop package

- Rust backend (Tauri + HTTP server)
  - Location: src-tauri/src/
  - Key modules:
    - commands.rs — Tauri commands and IPC handlers
    - scanner.rs — parallel scan pipeline (file hash → index → thumbnail)
    - server.rs — local HTTP endpoints for LAN sharing and image extraction
    - thumbnail.rs — WebP thumbnail generation
    - db.rs and models.rs — SQLite schema and data access

## How it fits together (short)
On startup, the Rust side initializes the database and a connection pool, while the React frontend invokes commands to request configuration and trigger scans. Scanning is pipelined and parallelized, and the web layer consumes the same backend APIs for mobile browsing.

## Build and run
Prerequisites:
- Node.js 18+ and pnpm
- Rust toolchain (stable) and the required Tauri platform dependencies

From the repository root:

Install dependencies
```bash
pnpm install
cd web
pnpm install
cd ..
```

Run the desktop app in development mode
```bash
pnpm build:web
pnpm tauri dev
```

Run the web SPA standalone
```bash
cd web
pnpm dev
```

Build the packaged desktop release
```bash
pnpm build:web
pnpm tauri build
```

Common scripts (see package.json):
- pnpm build:web — build the web SPA
- pnpm build — build the web assets, TypeScript, and Vite bundle
- pnpm tauri — run Tauri CLI tasks
- pnpm lint / pnpm format — code quality tools

## Key files and where to look
- src/ — desktop frontend (React + TypeScript)
  - src/main.tsx, App.tsx, src/components/*
- web/ — web SPA
  - web/src/*
- src-tauri/ — Rust backend and Tauri config
  - src-tauri/src/{commands.rs,scanner.rs,server.rs,thumbnail.rs,db.rs,models.rs}
  - src-tauri/tauri.conf.json, Cargo.toml

## Development notes
- The scanner pipeline is incremental; large libraries become usable early because thumbnails and database entries are created in parallel.
- Thumbnails are stored as WebP to keep file sizes small and rendering fast.
- The web UI expects endpoints that serve comic metadata and images; consult the backend modules for the exact routes and Tauri commands.

## Contributing
- Follow the project lint and formatting rules:
  - pnpm lint / pnpm lint:fix
  - pnpm format / pnpm format:check
- Use branch names such as feature/* or fix/* and include migration notes for any database or schema changes.

## License
MIT
