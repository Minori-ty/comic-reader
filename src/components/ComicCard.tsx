import { memo } from "react";
import type { ComicInfo } from "../types";

interface ComicCardProps {
  comic: ComicInfo;
  onClick: (comicId: number) => void;
}

/**
 * A single comic cover card in the library grid.
 * Uses the cover:// protocol to display the cached WebP thumbnail.
 */
export const ComicCard = memo(function ComicCard({
  comic,
  onClick,
}: ComicCardProps) {
  const coverSrc = `cover://localhost/${comic.id}`;

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
        {comic.coverPath ? (
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
