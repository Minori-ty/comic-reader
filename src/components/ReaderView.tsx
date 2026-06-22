import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { PageInfo } from "../types";
import { useAppStore } from "../store/useAppStore";

/** Header height from CSS variable `--reader-header-height`. */
const HEADER_HEIGHT = 44;

/** Conservative per-page height estimate (90% viewport minus header). */
function estimatedPageHeight() {
  return Math.round((window.innerHeight - HEADER_HEIGHT) * 0.9);
}

/**
 * Scroll-based comic reader (webtoon/manhwa style).
 *
 * Uses `@tanstack/react-virtual` so only visible pages + a small overscan
 * are rendered into the DOM. Page images are extracted from the ZIP on
 * demand as they scroll into the preload window — no more extracting all
 * 200+ pages before showing the first one.
 */
export function ReaderView() {
  const currentComicId = useAppStore((s) => s.currentComicId);
  const goToLibrary = useAppStore((s) => s.goToLibrary);
  const comics = useAppStore((s) => s.comics);

  const [pages, setPages] = useState<PageInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Map of page_idx → asset:// URL (populated lazily as pages scroll into view)
  const [pageUrls, setPageUrls] = useState<Map<number, string>>(new Map());

  // Track in-flight requests so we never double-fetch the same page
  const fetchingRef = useRef<Set<number>>(new Set());

  const scrollRef = useRef<HTMLDivElement>(null);

  const comic = useMemo(
    () => comics.find((c) => c.id === currentComicId),
    [comics, currentComicId],
  );

  // ── Virtual scroll ──
  const virtualizer = useVirtualizer({
    count: pages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimatedPageHeight,
    overscan: 3,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  const visibleRange = virtualizer.range;

  // ── Load page metadata (fast — DB query only, no ZIP extraction) ──
  useEffect(() => {
    if (!currentComicId) return;
    setLoading(true);
    setError(null);
    setPageUrls(new Map());
    fetchingRef.current.clear();

    invoke<PageInfo[]>("get_comic_pages", { comicId: currentComicId })
      .then(setPages)
      .catch((e) => {
        console.error("Failed to load pages:", e);
        setError(String(e));
      })
      .finally(() => setLoading(false));
  }, [currentComicId]);

  // ── Reset scroll position every time a new comic finishes loading ──
  // Deferred via rAF to avoid calling scrollTo during React's render phase,
  // which would cause the virtualizer to flushSync from inside a lifecycle.
  useEffect(() => {
    if (!loading && pages.length > 0) {
      const raf = requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top: 0 });
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [loading, pages.length]);

  // ── Lazy-extract pages that enter the preload window ──
  useEffect(() => {
    if (!visibleRange || pages.length === 0) return;

    // Preload 2 pages before and after the visible range
    const start = Math.max(0, visibleRange.startIndex - 2);
    const end = Math.min(pages.length - 1, visibleRange.endIndex + 2);

    for (let i = start; i <= end; i++) {
      const pageIdx = pages[i]?.pageIdx;
      if (pageIdx === undefined) continue;
      if (pageUrls.has(pageIdx) || fetchingRef.current.has(pageIdx)) continue;

      fetchingRef.current.add(pageIdx);
      invoke<string>("get_page_file_path", {
        comicId: currentComicId,
        pageIdx,
      })
        .then((filePath) => {
          setPageUrls((prev) => {
            const next = new Map(prev);
            next.set(pageIdx, convertFileSrc(filePath));
            return next;
          });
        })
        .catch((e) => {
          console.error(`Failed to get page ${pageIdx}:`, e);
        })
        .finally(() => {
          fetchingRef.current.delete(pageIdx);
        });
    }
  }, [visibleRange, pages, pageUrls, currentComicId]);

  // ── Keyboard navigation ──
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const el = scrollRef.current;
      if (!el) return;

      switch (e.key) {
        case "PageDown":
          e.preventDefault();
          el.scrollBy({ top: el.clientHeight * 0.9, behavior: "smooth" });
          break;
        case "ArrowDown":
          e.preventDefault();
          el.scrollBy({ top: 200, behavior: "smooth" });
          break;
        case "PageUp":
          e.preventDefault();
          el.scrollBy({ top: -el.clientHeight * 0.9, behavior: "smooth" });
          break;
        case "ArrowUp":
          e.preventDefault();
          el.scrollBy({ top: -200, behavior: "smooth" });
          break;
        case "Home":
          e.preventDefault();
          el.scrollTo({ top: 0, behavior: "smooth" });
          break;
        case "End":
          e.preventDefault();
          el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
          break;
        case "Escape":
          e.preventDefault();
          goToLibrary();
          break;
      }
    },
    [goToLibrary],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // ── Render ──

  if (loading) {
    return (
      <div className="reader-loading">
        <div className="reader-loading-spinner" />
        <p>Loading comic…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="reader-error">
        <h2>Error loading comic</h2>
        <p>{error}</p>
        <button onClick={goToLibrary}>Back to Library</button>
      </div>
    );
  }

  return (
    <div className="reader-view">
      <div className="reader-header">
        <button className="reader-back-btn" onClick={goToLibrary}>
          ← Library
        </button>
        <span className="reader-title">{comic?.fileName ?? "Reading"}</span>
        <span className="reader-page-info">{pages.length} pages</span>
      </div>

      <div ref={scrollRef} className="reader-scroll">
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const page = pages[virtualItem.index];
            const imgSrc = pageUrls.get(page.pageIdx);

            return (
              <div
                key={virtualItem.key}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
                className="reader-page"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                {imgSrc ? (
                  <img
                    src={imgSrc}
                    alt={`Page ${page.pageIdx + 1}`}
                    onError={(e) => {
                      console.error(
                        `Failed to load page ${page.pageIdx}:`,
                        e,
                      );
                    }}
                  />
                ) : (
                  <div className="reader-page-placeholder">
                    <div className="reader-page-spinner" />
                  </div>
                )}
                <div className="reader-page-number">
                  # {page.pageIdx + 1}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
