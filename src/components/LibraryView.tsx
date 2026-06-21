import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ComicInfo, ScanResult } from "../types";
import { useAppStore } from "../store/useAppStore";
import { ComicCard } from "./ComicCard";

const CARD_WIDTH = 200;
const CARD_HEIGHT = 300;
const CARD_GAP = 16;

/**
 * Library view with a virtual-scrolled grid of comic covers.
 * Comics appear incrementally during scanning via `comic-indexed` events
 * so the user doesn't have to wait for the full scan to complete.
 */
export function LibraryView() {
  const comics = useAppStore((s) => s.comics);
  const setComics = useAppStore((s) => s.setComics);
  const upsertComic = useAppStore((s) => s.upsertComic);
  const setLibraryPath = useAppStore((s) => s.setLibraryPath);
  const openReader = useAppStore((s) => s.openReader);
  const libraryPath = useAppStore((s) => s.libraryPath);

  const parentRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(800);

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

  // Listen for scan-complete — do a full refresh to catch removals
  useEffect(() => {
    const unlisten = listen<ScanResult>("scan-complete", async (event) => {
      console.log("Scan complete:", event.payload);
      // Full refresh to pick up removals and ensure sort consistency
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

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const loadInitialData = async () => {
    try {
      // Load library path
      const path = await invoke<string | null>("get_library_path");
      if (path) {
        setLibraryPath(path);
      }

      // Load comics
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

  // Calculate grid layout
  const columns = useMemo(() => {
    if (containerWidth < CARD_WIDTH) return 1;
    return Math.max(
      1,
      Math.floor((containerWidth + CARD_GAP) / (CARD_WIDTH + CARD_GAP)),
    );
  }, [containerWidth]);

  const rowCount = Math.ceil(comics.length / columns);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => CARD_HEIGHT + CARD_GAP,
    overscan: 3,
  });

  // Show empty state if no library path set
  if (!libraryPath) {
    return (
      <div className="library-empty">
        <div className="library-empty-icon">📚</div>
        <h2>Welcome to Comic Reader</h2>
        <p>Select a directory containing your comic ZIP files to get started.</p>
      </div>
    );
  }

  // Show empty state if library path set but no comics
  if (comics.length === 0) {
    return (
      <div className="library-empty">
        <div className="library-empty-icon">🔍</div>
        <h2>No Comics Found</h2>
        <p>
          No ZIP/CBZ files were found in the selected directory. Click "Scan" to
          search for comics.
        </p>
      </div>
    );
  }

  return (
    <div ref={parentRef} className="library-view">
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
              if (comicIdx >= comics.length) {
                return (
                  <div
                    key={`empty-${colIdx}`}
                    style={{ width: CARD_WIDTH, height: CARD_HEIGHT }}
                  />
                );
              }
              return (
                <div
                  key={comics[comicIdx].id}
                  style={{ width: CARD_WIDTH, height: CARD_HEIGHT }}
                >
                  <ComicCard
                    comic={comics[comicIdx]}
                    onClick={handleComicClick}
                  />
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
