import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { resolve } from "node:path"

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      s1sdk: resolve(__dirname, "../../../../../packages/s1sdk/src/index.ts"),
    },
  },
  build: {
    outDir: "../../../dist/ui",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3030",
    },
  },
})
