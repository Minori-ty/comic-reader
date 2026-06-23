export interface ComicInfo {
  id: number;
  filePath: string;
  fileName: string;
  fileHash: string;
  fileSize: number;
  pageCount: number;
  coverPath: string | null;
  addedAt: string;
  updatedAt: string;
}

export interface ComicEntry {
  id: number;
  fileName: string;
  pageCount: number;
  coverUrl: string;
}

export interface PageEntry {
  pageIdx: number;
  fileName: string;
}

const BASE = "";

export async function fetchComics(): Promise<ComicEntry[]> {
  const res = await fetch(`${BASE}/api/comics`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchPages(comicId: number): Promise<PageEntry[]> {
  const res = await fetch(`${BASE}/api/comics/${comicId}/pages`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function coverUrl(comicId: number): string {
  return `${BASE}/api/image/cover/${comicId}`;
}

export function pageUrl(comicId: number, pageIdx: number): string {
  return `${BASE}/api/image/page/${comicId}/${pageIdx}`;
}
