import type { NextConfig } from "next";

const e2eDistDir = process.env.CUSTENT_E2E_DIST_DIR;
if (
  e2eDistDir !== undefined &&
  !/^\.next-e2e-[0-9a-f]{32}$/u.test(e2eDistDir)
) {
  throw new Error("CUSTENT_E2E_DIST_DIR must name an isolated E2E build directory");
}

const nextConfig: NextConfig = {
  distDir: e2eDistDir ?? ".next",
  serverExternalPackages: ["pdfkit", "pg"],
};

export default nextConfig;
