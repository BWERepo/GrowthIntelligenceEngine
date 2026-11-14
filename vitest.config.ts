import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)), "cloudflare:sockets": fileURLToPath(new URL("./tests/unit/cloudflare-sockets-stub.ts", import.meta.url)) } },
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
