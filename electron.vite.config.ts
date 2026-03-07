import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const root = path.dirname(fileURLToPath(import.meta.url));
const alias = {
  "@main": path.join(root, "src/main"),
  "@renderer": path.join(root, "src/renderer"),
  "@shared": path.join(root, "src/shared")
};

export default defineConfig({
  main: {
    resolve: {
      alias
    },
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    resolve: {
      alias
    },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: path.join(root, "src/preload/index.cjs"),
          pet: path.join(root, "src/preload/pet.cjs")
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias
    },
    plugins: [react()]
  }
});
