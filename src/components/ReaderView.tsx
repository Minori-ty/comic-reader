import { useEffect, useMemo, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { PageInfo } from "../types";
import { useAppStore } from "../store/useAppStore";

/**
 * Scroll-based comic reader (webtoon/manhwa style).
 * Each page image fills the visible viewport height and is horizontally centered.
 * Page numbers sit below each image as separators.
 *
 * Images use `loading="lazy"` so off-screen pages don't consume
 * bandwidth until they're about to enter the viewport.
 */
export function ReaderView() {
  const currentComicId = useAppStore((s) => s.currentComicId);
  const goToLibrary = useAppStore((s) => s.goToLibrary);
  const comics = useAppStore((s) => s.comics);

  const [pages, setPages] = useState<PageInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Map of page_idx → asset:// URL
  const [pageUrls, setPageUrls] = useState<Map<number, string>>(new Map());

  const scrollRef = useRef<HTMLDivElement>(null);

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
          {pages.length} pages
        </span>
      </div>

      <div ref={scrollRef} className="reader-scroll">
        {pages.map((page) => {
          const imgSrc = pageUrls.get(page.pageIdx);

          return (
            <div key={page.pageIdx} className="reader-page">
              {imgSrc ? (
                <img
                  src={imgSrc}
                  alt={`Page ${page.pageIdx + 1}`}
                  loading="lazy"
                  decoding="async"
                  onError={(e) => {
                    console.error(
                      `Failed to load page ${page.pageIdx}:`,
                      e,
                    );
                  }}
                />
              ) : (
                <div className="reader-page-placeholder">
                  <p>Loading page {page.pageIdx + 1}…</p>
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
  );
}
