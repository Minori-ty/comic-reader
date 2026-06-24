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
import "./App.css";

function App() {
  const setServerInfo = useAppStore((s) => s.setServerInfo);
  const setQrDataUrl = useAppStore((s) => s.setQrDataUrl);

  // 启动时检查局域网共享是否已在运行（前端重启但后端未停的情况）
  useEffect(() => {
    invoke<ServerInfo | null>("get_server_status").then((info) => {
      if (info) {
        setServerInfo(info);
        QRCode.toDataURL(`${info.url}?lang=${i18n.language}`, {
          width: 240,
          margin: 2,
          color: { dark: "#e0e0e0", light: "#00000000" },
        }).then(setQrDataUrl);
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
