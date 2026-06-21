import { useAppStore } from "./store/useAppStore";
import { Toolbar } from "./components/Toolbar";
import { LibraryView } from "./components/LibraryView";
import { ReaderView } from "./components/ReaderView";
import "./App.css";

function App() {
  const currentView = useAppStore((s) => s.currentView);

  return (
    <div className="app">
      <Toolbar />
      <main className="app-main">
        <div style={{ display: currentView === "library" ? "block" : "none", height: "100%" }}>
          <LibraryView />
        </div>
        <div style={{ display: currentView === "reader" ? "block" : "none", height: "100%" }}>
          <ReaderView />
        </div>
      </main>
    </div>
  );
}

export default App;
