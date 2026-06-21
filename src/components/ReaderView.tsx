import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { PageInfo } from "../types";
import { useAppStore } from "../store/useAppStore";

/**
 * Scroll-based comic reader (webtoon/manhwa style).
 * Pages are extracted from ZIP to a cache directory on first access,
 * then loaded via Tauri's asset protocol (convertFileSrc).
 */
export function ReaderView() {
  const currentComicId = useAppStore((s) => s.currentComicId);
  const goToLibrary = useAppStore((s) => s.goToLibrary);
  const comics = useAppStore((s) => s.comics);

  const [pages, setPages] = useState<PageInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);

  // Map of page_idx → asset:// URL
  const [pageUrls, setPageUrls] = useState<Map<number, string>>(new Map());

  const parentRef = useRef<HTMLDivElement>(null);

  const comic = useMemo(
    () => comics.find((c) => c.id === currentComicId),
    [comics, currentComicId],
  );

  // Load pages and resolve file paths
  useEffect(() => {
    if (!currentComicId) return;
    loadPages();
  }, [currentComicId]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const el = parentRef.current;
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
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [goToLibrary]);

  const loadPages = async () => {
    if (!currentComicId) return;
    setLoading(true);
    setError(null);
    try {
      const pages = await invoke<PageInfo[]>("get_comic_pages", {
        comicId: currentComicId,
      });
      setPages(pages);

      // Pre-fetch all page file paths in parallel (with concurrency limit)
      const urlMap = new Map<number, string>();
      const CONCURRENCY = 8;

      for (let i = 0; i < pages.length; i += CONCURRENCY) {
        const batch = pages.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map(async (page) => {
            try {
              const filePath = await invoke<string>("get_page_file_path", {
                comicId: currentComicId,
                pageIdx: page.pageIdx,
              });
              return { pageIdx: page.pageIdx, url: convertFileSrc(filePath) };
            } catch (e) {
              console.error(
                `Failed to get page file path for page ${page.pageIdx}:`,
                e,
              );
              return null;
            }
          }),
        );
        for (const result of results) {
          if (result) {
            urlMap.set(result.pageIdx, result.url);
          }
        }
      }

      setPageUrls(urlMap);
    } catch (e) {
      console.error("Failed to load pages:", e);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  // Track which page is currently visible
  useEffect(() => {
    const el = parentRef.current;
    if (!el || pages.length === 0) return;

    const handleScroll = () => {
      if (!el) return;
      const scrollCenter = el.scrollTop + el.clientHeight / 2;
      const pageHeight = el.scrollHeight / Math.max(pages.length, 1);
      const pageIdx = Math.floor(scrollCenter / pageHeight) + 1;
      setCurrentPage(Math.min(pageIdx, pages.length));
    };

    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [pages.length]);

  // Virtual scrolling for the reader
  const virtualizer = useVirtualizer({
    count: pages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 800,
    overscan: 2,
  });

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
        <span className="reader-title">
          {comic?.fileName ?? "Reading"}
        </span>
        <span className="reader-page-info">
          {currentPage} / {pages.length}
        </span>
      </div>

      <div ref={parentRef} className="reader-scroll">
        <div
          className="reader-pages-container"
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
                className="reader-page"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualItem.start}px)`,
                }}
                data-index={virtualItem.index}
              >
                {imgSrc ? (
                  <img
                    src={imgSrc}
                    alt={`Page ${page.pageIdx + 1}`}
                    loading={virtualItem.index < 3 ? "eager" : "lazy"}
                    decoding="async"
                    onLoad={() => {
                      virtualizer.measure();
                    }}
                    onError={(e) => {
                      console.error(
                        `Failed to load page ${page.pageIdx}:`,
                        e,
                      );
                    }}
                  />
                ) : (
                  <div className="reader-loading" style={{ height: 400 }}>
                    <p>Loading page {page.pageIdx + 1}…</p>
                  </div>
                )}
                <div className="reader-page-number">
                  {page.pageIdx + 1}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
