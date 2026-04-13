import type { NextConfig } from "next";
import path from "node:path";

// Load the repo-root .env into process.env so API routes and the tsx
// subprocesses they spawn both see OPENAI_API_KEY without duplicating the file.
const rootEnv = path.resolve(__dirname, "..", ".env");
try {
  process.loadEnvFile(rootEnv);
} catch (err: unknown) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}

const config: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.resolve(__dirname, ".."),
};

export default config;
