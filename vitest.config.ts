import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": import.meta.dirname,
    },
  },
  test: {
    // PostgreSQL integration files share one durable-run queue. Serial files
    // prevent a mock worker in one file from claiming another file's run.
    fileParallelism: false,
    environment: "node",
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
