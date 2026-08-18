import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const staticEntry = resolve(import.meta.dirname, "static-entry");
const projectRoot = import.meta.dirname;

export default defineConfig({
  root: staticEntry,
  publicDir: resolve(projectRoot, "public"),
  plugins: [react()],
  css: {
    postcss: resolve(projectRoot, "postcss.config.mjs"),
  },
  build: {
    outDir: resolve(projectRoot, "dist-static"),
    emptyOutDir: true,
  },
});
