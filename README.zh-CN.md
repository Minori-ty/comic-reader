[English](./README.md) · [中文](./README.zh-CN.md)

# Comic Reader

本项目为本地漫画阅读器，采用 Tauri v2（Rust 后端）和 React 19（TypeScript 前端），支持 ZIP/CBZ 漫画、封面缩略图、虚拟滚动阅读器与局域网分享。

## 功能亮点
- 桌面端应用：Tauri (Rust) + React 19 + TypeScript
- Web SPA：Vite + React，移动端使用同一套后端 API
- 快速扫描本地漫画库，支持并行处理与去重
- 从压缩包条目生成 WebP 封面缩略图
- 虚拟滚动阅读器，按需加载页面以降低内存占用
- 内置 HTTP 服务用于局域网共享，并提供二维码便于快速访问
- 使用 SQLite 持久化，并带连接池管理

## 架构概览
- 前端（桌面端）
  - 位置：src/
  - 入口：src/main.tsx
  - 关键组件：
    - src/components/Toolbar.tsx — 目录选择、扫描、搜索、局域网分享/二维码、设置
    - src/components/LibraryView.tsx — 虚拟滚动网格、右键菜单、删除对话框
    - src/components/ReaderView.tsx — 垂直阅读器，支持虚拟滚动与懒加载页面
  - 状态管理：src/store/useAppStore.ts（Zustand）
  - 类型定义：src/types/

- Web SPA（移动端）
  - 位置：web/
  - 入口：web/src/main.tsx
  - 使用 HTTP 请求调用后端 API，例如 /api/comics 和 /api/image/*
  - 桌面端会消费构建好的 Web 资源

- Rust 后端（Tauri + HTTP Server）
  - 位置：src-tauri/src/
  - 关键模块：
    - commands.rs — Tauri 命令与 IPC 处理器
    - scanner.rs — 并行扫描流水线（文件哈希 → 索引 → 缩略图）
    - server.rs — 局域网分享与图片提取的 HTTP 接口
    - thumbnail.rs — WebP 缩略图生成
    - db.rs 与 models.rs — SQLite 数据结构与数据访问层

## 它们如何协同工作
启动时，Rust 侧会初始化数据库和连接池，同时 React 前端会调用命令来获取配置并触发扫描。扫描过程是流水线化并行处理的，移动端 Web 层也会使用同一套后端 API 来获取漫画元数据与图片。

## 构建与运行
前置条件：
- Node.js 18+ 和 pnpm
- Rust 工具链（stable）以及所需的 Tauri 平台依赖

在仓库根目录执行：

安装依赖
```bash
pnpm install
cd web
pnpm install
cd ..
```

开发模式运行桌面端应用
```bash
pnpm build:web
pnpm tauri dev
```

单独运行 Web SPA
```bash
cd web
pnpm dev
```

打包发布桌面端应用
```bash
pnpm build:web
pnpm tauri build
```

常用脚本（见 package.json）：
- pnpm build:web — 构建 Web SPA
- pnpm build — 构建 Web 资源、TypeScript 和 Vite bundle
- pnpm tauri — 运行 Tauri CLI 任务
- pnpm lint / pnpm format — 代码质量工具

## 关键文件位置
- src/ — 桌面端前端（React + TypeScript）
  - src/main.tsx、App.tsx、src/components/*
- web/ — Web SPA
  - web/src/*
- src-tauri/ — Rust 后端与 Tauri 配置
  - src-tauri/src/{commands.rs,scanner.rs,server.rs,thumbnail.rs,db.rs,models.rs}
  - src-tauri/tauri.conf.json, Cargo.toml

## 开发说明
- 扫描流程是增量式的，大型漫画库在处理缩略图和数据库条目时可以更早地变得可用。
- 缩略图会保存为 WebP 格式，以减少文件体积并提升渲染速度。
- Web 界面依赖后端提供的漫画元数据和图片接口，具体路由和 Tauri 命令请查看后端模块。

## 贡献
- 遵循项目的 lint 与格式化规则：
  - pnpm lint / pnpm lint:fix
  - pnpm format / pnpm format:check
- 使用类似 feature/* 或 fix/* 的分支命名，并在涉及数据库或 schema 变更时补充迁移说明。

## 许可证
MIT

---

如果你想继续，我也可以进一步为这个项目补充截图、功能列表或更详细的安装说明。
