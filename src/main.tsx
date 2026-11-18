import { createRoot } from "react-dom/client";
import App from "./App";
import "./style.css";
createRoot(document.getElementById("root")!).render(<App />);
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(new URL("./sw.js", document.baseURI), { scope: "./" })
      .catch(() => {});
  });
}
