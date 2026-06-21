import { memo, useMemo } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ComicInfo } from "../types";

interface ComicCardProps {
  comic: ComicInfo;
  onClick: (comicId: number) => void;
}

/**
 * A single comic cover card in the library grid.
 * Uses Tauri's built-in asset protocol via convertFileSrc() to load
 * the WebP thumbnail from the local filesystem.
 */
export const ComicCard = memo(function ComicCard({
  comic,
  onClick,
}: ComicCardProps) {
  const coverSrc = useMemo(() => {
    if (comic.coverFilePath) {
      return convertFileSrc(comic.coverFilePath);
    }
    return null;
  }, [comic.coverFilePath]);

  return (
    <div
      className="comic-card"
      onClick={() => onClick(comic.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick(comic.id);
        }
      }}
    >
      <div className="comic-card-cover">
        {coverSrc ? (
          <img
            src={coverSrc}
            alt={comic.fileName}
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="comic-card-placeholder">
            <span>No Cover</span>
          </div>
        )}
      </div>
      <div className="comic-card-title" title={comic.fileName}>
        {comic.fileName}
      </div>
      <div className="comic-card-pages">{comic.pageCount} pages</div>
    </div>
  );
});
