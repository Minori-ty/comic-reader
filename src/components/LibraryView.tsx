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
 * Library view with a virtual-scrolled grid of comic covers.
 *
 * Context menu and delete-confirmation dialog are managed as singletons
 * and rendered via portal to `document.body` so `position: fixed` works
 * regardless of the virtualiser's `transform` containers.
 */
export function LibraryView() {
  const comics = useAppStore((s) => s.comics);
  const setComics = useAppStore((s) => s.setComics);
  const upsertComic = useAppStore((s) => s.upsertComic);
  const setLibraryPath = useAppStore((s) => s.setLibraryPath);
  const openReader = useAppStore((s) => s.openReader);
  const goToLibrary = useAppStore((s) => s.goToLibrary);
  const libraryPath = useAppStore((s) => s.libraryPath);
  const searchQuery = useAppStore((s) => s.searchQuery);

  const parentRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  // ── Substring search ──
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
        // Find all occurrences of the query in the fileName (case-insensitive)
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

  // ── Singleton context menu state ──
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    comicId: 0,
    filePath: "",
    fileName: "",
  });

  // ── Delete confirmation dialog state ──
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState>({
    visible: false,
    comicId: 0,
    filePath: "",
    fileName: "",
  });
  const [deleteLocalFile, setDeleteLocalFile] = useState(false);

  // Load initial data on mount
  useEffect(() => {
    loadInitialData();
  }, []);

  // Listen for incremental comic updates during scanning
  useEffect(() => {
    const unlisten = listen<ComicInfo>("comic-indexed", (event) => {
      upsertComic(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [upsertComic]);

  // Listen for cache-cleared — refresh to empty list and go back to library
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

  // Listen for scan-complete — do a full refresh to catch removals
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

  // Track container width for grid column calculation
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    setContainerWidth(el.clientWidth);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // Ignore 0-width reports when the container is hidden (display:none)
        if (entry.contentRect.width > 0) {
          setContainerWidth(entry.contentRect.width);
        }
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // ── Context menu: close on click outside / Escape ──
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

  // ── Delete dialog: close on Escape ──
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
      // Remove from local state immediately
      setComics(comics.filter((c) => c.id !== deleteDialog.comicId));
    } catch (e) {
      console.error("delete_comic:", e);
    }
    setDeleteDialog({ visible: false, comicId: 0, filePath: "", fileName: "" });
  }, [deleteDialog.comicId, deleteLocalFile, comics, setComics]);

  const handleCancelDelete = useCallback(() => {
    setDeleteDialog((s) => ({ ...s, visible: false }));
  }, []);

  // Calculate grid layout
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
          <h2>Welcome to Comic Reader</h2>
          <p>Select a directory containing your comic ZIP files to get started.</p>
        </div>
      ) : filteredComics.length === 0 && searchQuery.trim() ? (
        <div className="library-empty">
          <div className="library-empty-icon">🔍</div>
          <h2>No Results</h2>
          <p>
            No comics match "{searchQuery}". Try a different search term.
          </p>
        </div>
      ) : comics.length === 0 ? (
        <div className="library-empty">
          <div className="library-empty-icon">🔍</div>
          <h2>No Comics Found</h2>
          <p>
            No ZIP/CBZ files were found in the selected directory. Click "Scan"
            to search for comics.
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

      {/* ── Context menu (portal → body) ── */}
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

      {/* ── Delete confirmation dialog (portal → body) ── */}
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
