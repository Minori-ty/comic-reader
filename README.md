# Comic Reader

[中文简介（点此查看）](#中文翻译)

A high-performance local comic reader built with Tauri v2 (Rust backend) and React 19 (TypeScript frontend). It supports ZIP/CBZ comics with cover thumbnails, virtual-scrolled reading, and LAN sharing (with QR codes). The project provides both a desktop app (Tauri) and a mobile-friendly web SPA.

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
On startup, the Rust side initializes the database and a connection pool, while the React frontend invokes commands to request configuration and trigger scans. Scanning is pipelined and parallelized: file hashing, metadata extraction, and thumbnail generation happen in a coordinated workflow, and the UI updates incrementally as items are indexed. ReaderView requests pages on demand so memory usage stays low and large libraries remain responsive.

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

---

## 中文翻译

本项目为本地漫画阅读器，采用 Tauri v2（Rust 后端）和 React + TypeScript 前端，支持 ZIP/CBZ 漫画、封面缩略图、虚拟滚动阅读器与局域网分享（含二维码）。项目同时包含桌面应用和移动友好的 Web SPA。

- 前端（桌面）位于 src/，入口 src/main.tsx；主要组件见 src/components/*（Toolbar、LibraryView、ReaderView 等）。
- 移动 Web SPA 位于 web/，入口 web/src/main.tsx，使用 HTTP API 来获取漫画列表和图片。
- 后端位于 src-tauri/src/，包含命令处理、扫描器、内置 HTTP 服务器、缩略图生成、SQLite 数据层等模块。

开发快速上手（简要）
1. 安装依赖：pnpm install（并在 web/ 中执行 pnpm install）
2. 本地开发（先构建 web，再运行 Tauri 开发模式）：
   ```bash
   pnpm build:web
   pnpm tauri dev
   ```
3. 单独运行 web（开发）：
   ```bash
   cd web
   pnpm dev
   ```
4. 打包发布：
   ```bash
   pnpm build:web
   pnpm tauri build
   ```

如果你想继续，我也可以进一步为这个 README 增加截图、功能列表或更多详细的安装说明。
