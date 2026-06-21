import { create } from "zustand";
import type { AppView, ComicInfo, ScanResult } from "../types";

interface AppState {
  // Library
  libraryPath: string | null;
  comics: ComicInfo[];
  scanResult: ScanResult | null;
  isScanning: boolean;

  // Reader
  currentView: AppView;
  currentComicId: number | null;

  // Actions
  setLibraryPath: (path: string | null) => void;
  setComics: (comics: ComicInfo[]) => void;
  /** Insert or replace a single comic (for real-time scan updates). */
  upsertComic: (comic: ComicInfo) => void;
  setScanResult: (result: ScanResult | null) => void;
  setIsScanning: (scanning: boolean) => void;
  openReader: (comicId: number) => void;
  goToLibrary: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  libraryPath: null,
  comics: [],
  scanResult: null,
  isScanning: false,
  currentView: "library",
  currentComicId: null,

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

  setScanResult: (result) => set({ scanResult: result }),
  setIsScanning: (scanning) => set({ isScanning: scanning }),
  openReader: (comicId) =>
    set({ currentView: "reader", currentComicId: comicId }),
  goToLibrary: () =>
    set({ currentView: "library", currentComicId: null }),
}));
