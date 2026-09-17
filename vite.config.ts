import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { CURRENT_SOURCE_ID } from "./src/core/source-identity.js";

export default defineConfig({
  plugins: [react()],
  define: { __CALCULATOR_SOURCE_ID__: JSON.stringify(CURRENT_SOURCE_ID) },
  server: {
    host: "127.0.0.1"
  }
});
