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
        {currentView === "library" ? <LibraryView /> : <ReaderView />}
      </main>
    </div>
  );
}

export default App;
