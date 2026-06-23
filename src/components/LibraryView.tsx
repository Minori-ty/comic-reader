import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ComicInfo, ScanResult } from "../types";
import { useAppStore } from "../store/useAppStore";
import { ComicCard } from "./ComicCard";
import type { HighlightRange } from "./ComicCard";

const CARD_WIDTH = 200;
const CARD_HEIGHT = 300;
const CARD_GAP = 16;

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  comicId: number;
  filePath: string;
  fileName: string;
}

interface DeleteDialogState {
  visible: boolean;
  comicId: number;
  filePath: string;
  fileName: string;
}

/**
 * 漫画库视图 — 使用虚拟滚动的封面网格布局。
 *
 * 右键菜单和删除确认弹窗作为单例管理，
 * 通过 createPortal 渲染到 `document.body`，
 * 避免虚拟列表的 `transform` 容器影响 `position: fixed` 定位。
 */
export function LibraryView() {
  const comics = useAppStore((s) => s.comics);
  const setComics = useAppStore((s) => s.setComics);
  const batchUpsertComics = useAppStore((s) => s.batchUpsertComics);
  const setLibraryPath = useAppStore((s) => s.setLibraryPath);
  const openReader = useAppStore((s) => s.openReader);
  const goToLibrary = useAppStore((s) => s.goToLibrary);
  const libraryPath = useAppStore((s) => s.libraryPath);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const isScanning = useAppStore((s) => s.isScanning);

  const parentRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  // ── 子串搜索 ──
  const { filteredComics, matchMap } = useMemo(() => {
    const q = searchQuery.trim();
    if (!q) {
      return { filteredComics: comics, matchMap: null };
    }
    const lowerQ = q.toLowerCase();
    const map = new Map<number, readonly HighlightRange[]>();
    const items: ComicInfo[] = [];
    for (const comic of comics) {
      const lowerName = comic.fileName.toLowerCase();
      const idx = lowerName.indexOf(lowerQ);
      if (idx !== -1) {
        items.push(comic);
        // 查找 fileName 中所有匹配位置（不区分大小写）
        const ranges: [number, number][] = [];
        let start = 0;
        while (start < lowerName.length) {
          const pos = lowerName.indexOf(lowerQ, start);
          if (pos === -1) break;
          ranges.push([pos, pos + q.length - 1]);
          start = pos + 1;
        }
        map.set(comic.id, ranges);
      }
    }
    return { filteredComics: items, matchMap: map };
  }, [comics, searchQuery]);

  // ── 右键菜单单例状态 ──
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    comicId: 0,
    filePath: "",
    fileName: "",
  });

  // ── 删除确认弹窗状态 ──
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState>({
    visible: false,
    comicId: 0,
    filePath: "",
    fileName: "",
  });
  const [deleteLocalFile, setDeleteLocalFile] = useState(false);

  // 挂载时加载初始数据
  useEffect(() => {
    loadInitialData();
  }, []);

  // 扫描期间监听增量漫画更新（100ms 窗口批量合并）
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let batch: ComicInfo[] = [];

    const unlisten = listen<ComicInfo>("comic-indexed", (event) => {
      batch.push(event.payload);
      if (timer === null) {
        timer = setTimeout(() => {
          const items = batch;
          batch = [];
          timer = null;
          batchUpsertComics(items);
        }, 100);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
      if (timer !== null) clearTimeout(timer);
    };
  }, [batchUpsertComics]);

  // 监听缓存清除事件 — 刷新列表并返回库视图
  useEffect(() => {
    const unlisten = listen("cache-cleared", async () => {
      goToLibrary();
      try {
        const fresh = await invoke<ComicInfo[]>("get_comics");
        setComics(fresh);
      } catch (e) {
        console.error("Failed to refresh comics after cache clear:", e);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [setComics, goToLibrary]);

  // 监听扫描完成事件 — 全量刷新以捕获已移除的文件
  useEffect(() => {
    const unlisten = listen<ScanResult>("scan-complete", async (event) => {
      console.log("Scan complete:", event.payload);
      try {
        const fresh = await invoke<ComicInfo[]>("get_comics");
        setComics(fresh);
      } catch (e) {
        console.error("Failed to refresh comics after scan:", e);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [setComics]);

  // 跟踪容器宽度，用于计算网格列数
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    setContainerWidth(el.clientWidth);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // 忽略容器隐藏时（display:none）的 0 宽度报告
        if (entry.contentRect.width > 0) {
          setContainerWidth(entry.contentRect.width);
        }
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // ── 右键菜单：点击外部或按 Escape 关闭 ──
  useEffect(() => {
    if (!contextMenu.visible) return;

    const close = () => setContextMenu((s) => ({ ...s, visible: false }));

    const handleMouseDown = (e: MouseEvent) => {
      const menu = document.querySelector(".context-menu");
      if (menu && menu.contains(e.target as Node)) return;
      close();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu.visible]);

  // ── 删除弹窗：按 Escape 关闭 ──
  useEffect(() => {
    if (!deleteDialog.visible) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDeleteDialog((s) => ({ ...s, visible: false }));
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [deleteDialog.visible]);

  const loadInitialData = async () => {
    try {
      const path = await invoke<string | null>("get_library_path");
      if (path) {
        setLibraryPath(path);
      }
      const comics = await invoke<ComicInfo[]>("get_comics");
      setComics(comics);
      console.log(`Loaded ${comics.length} comics from database`);
    } catch (e) {
      console.error("Failed to load initial data:", e);
    }
  };

  const handleComicClick = useCallback(
    (comicId: number) => {
      openReader(comicId);
    },
    [openReader],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, comic: ComicInfo) => {
      setContextMenu({
        visible: true,
        x: e.clientX,
        y: e.clientY,
        comicId: comic.id,
        filePath: comic.filePath,
        fileName: comic.fileName,
      });
    },
    [],
  );

  const handleOpenFileLocation = useCallback(() => {
    invoke("open_file_location", { path: contextMenu.filePath }).catch(
      (e) => console.error("open_file_location:", e),
    );
    setContextMenu((s) => ({ ...s, visible: false }));
  }, [contextMenu.filePath]);

  const handleTriggerDelete = useCallback(() => {
    setContextMenu((s) => ({ ...s, visible: false }));
    setDeleteDialog({
      visible: true,
      comicId: contextMenu.comicId,
      filePath: contextMenu.filePath,
      fileName: contextMenu.fileName,
    });
    setDeleteLocalFile(false);
  }, [contextMenu.comicId, contextMenu.filePath, contextMenu.fileName]);

  const handleConfirmDelete = useCallback(async () => {
    try {
      await invoke("delete_comic", {
        comicId: deleteDialog.comicId,
        deleteLocalFile,
      });
      // 立即从本地状态移除
      setComics(comics.filter((c) => c.id !== deleteDialog.comicId));
    } catch (e) {
      console.error("delete_comic:", e);
    }
    setDeleteDialog({ visible: false, comicId: 0, filePath: "", fileName: "" });
  }, [deleteDialog.comicId, deleteLocalFile, comics, setComics]);

  const handleCancelDelete = useCallback(() => {
    setDeleteDialog((s) => ({ ...s, visible: false }));
  }, []);

  // 计算网格布局
  const columns = useMemo(() => {
    const w = containerWidth || 800;
    if (w < CARD_WIDTH) return 1;
    return Math.max(1, Math.floor((w + CARD_GAP) / (CARD_WIDTH + CARD_GAP)));
  }, [containerWidth]);

  const rowCount = Math.ceil(filteredComics.length / columns);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => CARD_HEIGHT + CARD_GAP,
    overscan: 3,
  });

  return (
    <div ref={parentRef} className="library-view">
      {!libraryPath ? (
        <div className="library-empty">
          <div className="library-empty-icon">📚</div>
          <h2>欢迎使用 Comic Reader</h2>
          <p>选择一个包含漫画 ZIP/CBZ 文件的目录开始使用。</p>
        </div>
      ) : isScanning && comics.length === 0 ? (
        <div className="library-loading">
          <div className="library-loading-spinner" />
          <h2>正在扫描漫画…</h2>
          <p>正在从目录中查找并索引漫画文件</p>
        </div>
      ) : filteredComics.length === 0 && searchQuery.trim() ? (
        <div className="library-empty">
          <div className="library-empty-icon">🔍</div>
          <h2>无结果</h2>
          <p>
            没有匹配 "{searchQuery}" 的漫画，请尝试其他关键词。
          </p>
        </div>
      ) : comics.length === 0 ? (
        <div className="library-empty">
          <div className="library-empty-icon">🔍</div>
          <h2>未找到漫画</h2>
          <p>
            所选目录中未找到 ZIP/CBZ 文件，点击"扫描"按钮重新搜索。
          </p>
        </div>
      ) : (
        <div
          className="library-grid-container"
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => (
            <div
              key={virtualRow.key}
              className="library-row"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
                display: "flex",
                gap: `${CARD_GAP}px`,
                justifyContent: "center",
              }}
            >
              {Array.from({ length: columns }).map((_, colIdx) => {
                const comicIdx = virtualRow.index * columns + colIdx;
                if (comicIdx >= filteredComics.length) {
                  return (
                    <div
                      key={`empty-${colIdx}`}
                      style={{ width: CARD_WIDTH, height: CARD_HEIGHT }}
                    />
                  );
                }
                const comic = filteredComics[comicIdx];
                return (
                  <div
                    key={comic.id}
                    style={{ width: CARD_WIDTH, height: CARD_HEIGHT }}
                  >
                    <ComicCard
                      comic={comic}
                      onClick={handleComicClick}
                      onContextMenu={handleContextMenu}
                      highlightRanges={matchMap?.get(comic.id)}
                    />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {/* ── 右键菜单（portal → body） ── */}
      {contextMenu.visible &&
        createPortal(
          <div
            className="context-menu"
            style={{
              left: Math.min(contextMenu.x, window.innerWidth - 190),
              top: Math.min(contextMenu.y, window.innerHeight - 120),
            }}
          >
            <button
              className="context-menu-item"
              onClick={handleOpenFileLocation}
            >
              打开文件位置
            </button>
            <div className="context-menu-separator" />
            <button
              className="context-menu-item context-menu-item-danger"
              onClick={handleTriggerDelete}
            >
              删除
            </button>
          </div>,
          document.body,
        )}

      {/* ── 删除确认弹窗（portal → body） ── */}
      {deleteDialog.visible &&
        createPortal(
          <div className="dialog-overlay" onClick={handleCancelDelete}>
            <div
              className="dialog"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
            >
              <h3 className="dialog-title">确认删除</h3>
              <p className="dialog-message">
                确定要删除「{deleteDialog.fileName}」吗？此操作不可撤销。
              </p>

              <label className="dialog-checkbox">
                <input
                  type="checkbox"
                  checked={deleteLocalFile}
                  onChange={(e) => setDeleteLocalFile(e.target.checked)}
                />
                <span>同时删除本地文件</span>
              </label>

              <div className="dialog-actions">
                <button
                  className="dialog-btn dialog-btn-cancel"
                  onClick={handleCancelDelete}
                >
                  取消
                </button>
                <button
                  className="dialog-btn dialog-btn-danger"
                  onClick={handleConfirmDelete}
                >
                  删除
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
