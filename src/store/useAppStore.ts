import { create } from "zustand";
import type { ComicInfo, ScanProgress, ScanResult, ServerInfo } from "../types";

interface AppState {
  // Library
  libraryPath: string | null;
  comics: ComicInfo[];
  scanResult: ScanResult | null;
  scanProgress: ScanProgress | null;
  isScanning: boolean;
  searchQuery: string;

  // Language
  language: string;
  setLanguage: (lang: string) => void;

  // LAN Share
  serverInfo: ServerInfo | null;
  qrDataUrl: string | null;
  shareOpen: boolean;
  shareLoading: boolean;
  shareError: string | null;
  setServerInfo: (info: ServerInfo | null) => void;
  setQrDataUrl: (url: string | null) => void;
  setShareOpen: (open: boolean) => void;
  setShareLoading: (loading: boolean) => void;
  setShareError: (error: string | null) => void;

  // Actions
  setLibraryPath: (path: string | null) => void;
  setComics: (comics: ComicInfo[]) => void;
  /** Insert or replace a single comic (for real-time scan updates). */
  upsertComic: (comic: ComicInfo) => void;
  /** Batch insert or replace multiple comics — one array copy, one render. */
  batchUpsertComics: (comics: ComicInfo[]) => void;
  setScanResult: (result: ScanResult | null) => void;
  setScanProgress: (progress: ScanProgress | null) => void;
  setIsScanning: (scanning: boolean) => void;
  setSearchQuery: (query: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  libraryPath: null,
  comics: [],
  scanResult: null,
  scanProgress: null,
  isScanning: false,
  searchQuery: "",
  language: "zh",

  // LAN Share
  serverInfo: null,
  qrDataUrl: null,
  shareOpen: false,
  shareLoading: false,
  shareError: null,
  setServerInfo: (info) => set({ serverInfo: info }),
  setQrDataUrl: (url) => set({ qrDataUrl: url }),
  setShareOpen: (open) => set({ shareOpen: open }),
  setShareLoading: (loading) => set({ shareLoading: loading }),
  setShareError: (error) => set({ shareError: error }),

  setLanguage: (language) => set({ language }),

  setLibraryPath: (path) => set({ libraryPath: path }),
  setComics: (comics) => set({ comics }),

  upsertComic: (comic) =>
    set((state) => {
      const idx = state.comics.findIndex((c) => c.id === comic.id);
      let newComics: ComicInfo[];
      if (idx >= 0) {
        // Replace existing
        newComics = [...state.comics];
        newComics[idx] = comic;
      } else {
        // Insert new, maintaining sort by fileName
        newComics = [...state.comics, comic];
        newComics.sort((a, b) =>
          a.fileName.localeCompare(b.fileName, undefined, {
            numeric: true,
            sensitivity: "base",
          }),
        );
      }
      return { comics: newComics };
    }),

  /** Batch insert/update — one array copy + one sort, then one render. */
  batchUpsertComics: (incoming) =>
    set((state) => {
      if (incoming.length === 0) return {};
      const existing = new Map<number, ComicInfo>(
        state.comics.map((c) => [c.id, c]),
      );
      for (const comic of incoming) {
        existing.set(comic.id, comic);
      }
      const merged = Array.from(existing.values());
      merged.sort((a, b) =>
        a.fileName.localeCompare(b.fileName, undefined, {
          numeric: true,
          sensitivity: "base",
        }),
      );
      return { comics: merged };
    }),

  setScanResult: (result) => set({ scanResult: result }),
  setScanProgress: (progress) => set({ scanProgress: progress }),
  setIsScanning: (scanning) => set({ isScanning: scanning }),
  setSearchQuery: (query) => set({ searchQuery: query }),
}));
