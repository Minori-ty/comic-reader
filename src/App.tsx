import { useEffect } from "react";
import { Routes, Route } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import QRCode from "qrcode";
import i18n from "./i18n";
import { Toolbar } from "./components/Toolbar";
import { LibraryView } from "./components/LibraryView";
import { ReaderView } from "./components/ReaderView";
import { useAppStore } from "./store/useAppStore";
import type { ServerInfo } from "./types";
import { QR_OPTIONS } from "./constants";
import "./App.css";

function App() {
  const setServerInfo = useAppStore((s) => s.setServerInfo);
  const setQrDataUrl = useAppStore((s) => s.setQrDataUrl);

  // 启动时从 Rust 加载当前语言（首次启动自动检测系统语言）
  useEffect(() => {
    invoke<string>("get_language").then((lang) => {
      if (lang !== i18n.language) {
        i18n.changeLanguage(lang);
      }
    }).catch((e) => {
      console.error("get_language:", e);
    });
  }, []);

  // 启动时检查局域网共享是否已在运行（前端重启但后端未停的情况）
  useEffect(() => {
    invoke<ServerInfo | null>("get_server_status").then((info) => {
      if (info) {
        setServerInfo(info);
        QRCode.toDataURL(info.url, QR_OPTIONS).then(setQrDataUrl);
      }
    }).catch((e) => {
      console.error("get_server_status:", e);
    });
  }, [setServerInfo, setQrDataUrl]);

  return (
    <div className="app">
      <Toolbar />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<LibraryView />} />
          <Route path="/reader/:comicId" element={<ReaderView />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
