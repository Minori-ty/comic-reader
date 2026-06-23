import { Routes, Route } from "react-router-dom";
import { Toolbar } from "./components/Toolbar";
import { LibraryView } from "./components/LibraryView";
import { ReaderView } from "./components/ReaderView";
import "./App.css";

function App() {
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
