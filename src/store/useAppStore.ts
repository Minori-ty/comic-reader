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
  setScanResult: (result) => set({ scanResult: result }),
  setIsScanning: (scanning) => set({ isScanning: scanning }),
  openReader: (comicId) =>
    set({ currentView: "reader", currentComicId: comicId }),
  goToLibrary: () =>
    set({ currentView: "library", currentComicId: null }),
}));
