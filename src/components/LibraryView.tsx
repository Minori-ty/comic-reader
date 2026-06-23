import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ComicInfo, ScanResult } from "../types";
import { useAppStore } from "../store/useAppStore";
import { ComicCard } from "./ComicCard";
import type { HighlightRange } from "./ComicCard";

const CARD_W = 180;
const CARD_H = 300;
const GAP = 16;
/** 窗口宽度转为可用内容宽度的扣除量（滚动条 ~8px + library-view padding 32px） */
const CHROME = 40;

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
 * 漫画库视图 — CSS Grid 自适应列数 + 虚拟滚动行。
 *
 * 右键菜单和删除确认弹窗作为单例管理，
 * 通过 createPortal 渲染到 `document.body`，
 * 避免虚拟列表的 `transform` 容器影响 `position: fixed` 定位。
 */
export function LibraryView() {
  const { t } = useTranslation()
  const navigate = useNavigate();
  const comics = useAppStore((s) => s.comics);
  const setComics = useAppStore((s) => s.setComics);
  const batchUpsertComics = useAppStore((s) => s.batchUpsertComics);
  const setLibraryPath = useAppStore((s) => s.setLibraryPath);
  const libraryPath = useAppStore((s) => s.libraryPath);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const isScanning = useAppStore((s) => s.isScanning);

  const parentRef = useRef<HTMLDivElement>(null);

  // 用 window.innerWidth 计算可用内容宽度（同步、可靠）
  const [vw, setVw] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

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
      navigate("/");
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
  }, [setComics, navigate]);

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

  // 自适应列数
  const columns = useMemo(() => {
    const avail = vw - CHROME;
    return Math.max(1, Math.floor((avail + GAP) / (CARD_W + GAP)));
  }, [vw]);
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
      const [path, comics] = await Promise.all([
        invoke<string | null>("get_library_path"),
        invoke<ComicInfo[]>("get_comics"),
      ]);
      if (path) {
        setLibraryPath(path);
      }
      setComics(comics);
      console.log(`Loaded ${comics.length} comics from database`);
    } catch (e) {
      console.error("Failed to load initial data:", e);
    }
  };

  const handleComicClick = useCallback(
    (comicId: number) => {
      navigate(`/reader/${comicId}`);
    },
    [navigate],
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

  const rowCount = Math.ceil(filteredComics.length / columns);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => CARD_H + GAP,
    overscan: 3,
  });

  return (
    <div ref={parentRef} className="library-view">
      {!libraryPath ? (
        <div className="library-empty">
          <div className="library-empty-icon">📚</div>
          <h2>{t('library.welcome')}</h2>
          <p>{t('library.welcomeHint')}</p>
        </div>
      ) : isScanning && comics.length === 0 ? (
        <div className="library-loading">
          <div className="library-loading-spinner" />
          <h2>{t('library.scanning')}</h2>
          <p>{t('library.scanningHint')}</p>
        </div>
      ) : filteredComics.length === 0 && searchQuery.trim() ? (
        <div className="library-empty">
          <div className="library-empty-icon">🔍</div>
          <h2>{t('library.noResults')}</h2>
          <p>
            {t('library.noResultsHint', { query: searchQuery })}
          </p>
        </div>
      ) : comics.length === 0 ? (
        <div className="library-empty">
          <div className="library-empty-icon">🔍</div>
          <h2>{t('library.noComics')}</h2>
          <p>
            {t('library.noComicsHint')}
          </p>
        </div>
      ) : (
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => (
            <div
              key={virtualRow.key}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
                display: "grid",
                gridTemplateColumns: `repeat(${columns}, ${CARD_W}px)`,
                gap: `${GAP}px`,
                justifyContent: "center",
                padding: "0 0 16px 0",
              }}
            >
              {Array.from({ length: columns }).map((_, colIdx) => {
                const comicIdx = virtualRow.index * columns + colIdx;
                if (comicIdx >= filteredComics.length) {
                  return <div key={`empty-${colIdx}`} />;
                }
                const comic = filteredComics[comicIdx];
                return (
                  <ComicCard
                    key={comic.id}
                    comic={comic}
                    onClick={handleComicClick}
                    onContextMenu={handleContextMenu}
                    highlightRanges={matchMap?.get(comic.id)}
                  />
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
              {t('library.openFileLocation')}
            </button>
            <div className="context-menu-separator" />
            <button
              className="context-menu-item context-menu-item-danger"
              onClick={handleTriggerDelete}
            >
              {t('library.delete')}
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
              <h3 className="dialog-title">{t('library.confirmDelete')}</h3>
              <p className="dialog-message">
                {t('library.deleteMsg', { name: deleteDialog.fileName })}
              </p>

              <label className="dialog-checkbox">
                <input
                  type="checkbox"
                  checked={deleteLocalFile}
                  onChange={(e) => setDeleteLocalFile(e.target.checked)}
                />
                <span>{t('library.deleteLocal')}</span>
              </label>

              <div className="dialog-actions">
                <button
                  className="dialog-btn dialog-btn-cancel"
                  onClick={handleCancelDelete}
                >
                  {t('library.cancel')}
                </button>
                <button
                  className="dialog-btn dialog-btn-danger"
                  onClick={handleConfirmDelete}
                >
                  {t('library.delete')}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
