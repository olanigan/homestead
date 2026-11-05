import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./components/App"

// Light is the default; the choice is remembered across reloads.
const storedTheme = localStorage.getItem("homestead-theme")
document.documentElement.dataset.theme = storedTheme === "dark" ? "dark" : "light"

const root = createRoot(document.getElementById("root")!)
root.render(<App />)
