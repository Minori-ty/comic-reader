import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Library } from "./pages/Library";
import { Reader } from "./pages/Reader";
import "./App.css";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Library />} />
        <Route path="/reader/:comicId" element={<Reader />} />
      </Routes>
    </BrowserRouter>
  );
}
