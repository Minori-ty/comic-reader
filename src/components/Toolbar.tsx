import { useCallback, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import type { ScanResult } from "../types";
import { useAppStore } from "../store/useAppStore";

/**
 * Top toolbar with directory picker and scan controls.
 */
export function Toolbar() {
  const libraryPath = useAppStore((s) => s.libraryPath);
  const setLibraryPath = useAppStore((s) => s.setLibraryPath);
  const setComics = useAppStore((s) => s.setComics);
  const setScanResult = useAppStore((s) => s.setScanResult);
  const setIsScanning = useAppStore((s) => s.setIsScanning);
  const isScanning = useAppStore((s) => s.isScanning);
  const scanResult = useAppStore((s) => s.scanResult);
  const currentView = useAppStore((s) => s.currentView);
  const goToLibrary = useAppStore((s) => s.goToLibrary);

  const scanInProgress = useRef(false);

  const handlePickDirectory = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select Comic Library Directory",
      });
      if (selected && typeof selected === "string") {
        setLibraryPath(selected);
        await doScan(selected);
      }
    } catch (e) {
      console.error("Directory picker error:", e);
    }
  }, []);

  const handleRescan = useCallback(async () => {
    if (libraryPath) {
      await doScan(libraryPath);
    }
  }, [libraryPath]);

  const doScan = async (path: string) => {
    if (scanInProgress.current) return;
    scanInProgress.current = true;
    setIsScanning(true);
    setScanResult(null);

    try {
      const result = await invoke<ScanResult>("set_library_path", {
        path,
      });
      setScanResult(result);

      // Refresh the comic list
      const comics = await invoke<any[]>("get_comics");
      setComics(comics);
    } catch (e) {
      console.error("Scan error:", e);
      setScanResult({
        totalFiles: 0,
        newComics: 0,
        updatedComics: 0,
        removedComics: 0,
        skippedComics: 0,
        errors: [String(e)],
      });
    } finally {
      setIsScanning(false);
      scanInProgress.current = false;
    }
  };

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        {currentView === "reader" && (
          <button className="toolbar-btn" onClick={goToLibrary}>
            ← Library
          </button>
        )}
        <span className="toolbar-title">Comic Reader</span>
      </div>

      <div className="toolbar-right">
        {libraryPath && (
          <span className="toolbar-path" title={libraryPath}>
            {libraryPath}
          </span>
        )}
        <button
          className="toolbar-btn"
          onClick={handlePickDirectory}
          disabled={isScanning}
        >
          {libraryPath ? "Change Directory" : "Select Directory"}
        </button>
        {libraryPath && (
          <button
            className="toolbar-btn toolbar-btn-scan"
            onClick={handleRescan}
            disabled={isScanning}
          >
            {isScanning ? "Scanning…" : "Scan"}
          </button>
        )}
      </div>

      {scanResult && (
        <div
          className={`scan-summary ${scanResult.errors.length > 0 ? "scan-summary-errors" : ""}`}
        >
          {scanResult.newComics > 0 && <span>+{scanResult.newComics} new </span>}
          {scanResult.updatedComics > 0 && (
            <span>↻{scanResult.updatedComics} updated </span>
          )}
          {scanResult.removedComics > 0 && (
            <span>-{scanResult.removedComics} removed </span>
          )}
          {scanResult.skippedComics > 0 && (
            <span>✓{scanResult.skippedComics} unchanged </span>
          )}
          {scanResult.errors.length > 0 && (
            <span className="scan-errors">
              ⚠ {scanResult.errors.length} errors
            </span>
          )}
        </div>
      )}
    </div>
  );
}
