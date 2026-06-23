import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { fetchPages, pageUrl, type PageEntry } from "../api";

export function Reader() {
  const { comicId } = useParams<{ comicId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<PageEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 从路由 state 获取 title，回退到 comicId
  const title = (location.state as { title?: string } | null)?.title || `漫画 #${comicId}`;

  useEffect(() => {
    if (!comicId) return;
    setLoading(true);
    fetchPages(Number(comicId))
      .then((data) => {
        setPages(data);
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, [comicId]);

  const virtualizer = useVirtualizer({
    count: pages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 600,
    overscan: 2,
  });

  if (loading) {
    return (
      <div className="loading-view">
        <div className="spinner" />
        <p>加载中…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="reader-page-wrap">
        <div className="reader-header">
          <button className="reader-back" onClick={() => navigate("/")}>
            ← 返回
          </button>
          <span className="reader-title">错误</span>
        </div>
        <div className="empty-view">
          <h2>加载失败</h2>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="reader-page-wrap">
      <div className="reader-header">
        <button className="reader-back" onClick={() => navigate("/")}>
          ← 返回
        </button>
        <span className="reader-title">{title}</span>
        <span className="reader-count">{pages.length} 页</span>
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
            const p = pages[virtualItem.index];
            if (!p) return null;
            return (
              <div
                key={virtualItem.key}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualItem.start}px)`,
                }}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
              >
                <img
                  src={pageUrl(Number(comicId), p.pageIdx)}
                  alt={`第 ${p.pageIdx + 1} 页`}
                  loading="lazy"
                  style={{ width: "100%", display: "block" }}
                  onError={(e) => {
                    const img = e.target as HTMLImageElement;
                    img.style.display = "none";
                    const ph = img.parentElement!.querySelector(".page-ph") as HTMLElement;
                    if (ph) ph.style.display = "flex";
                  }}
                />
                <div className="page-ph" style={{ display: "none", minHeight: "60vh", alignItems: "center", justifyContent: "center" }}>
                  <div className="spinner" />
                </div>
                <div className="page-num">
                  {p.pageIdx + 1} / {pages.length}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
