import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";

export function loadProjectEnvFile(
  workingDirectory: string = process.cwd(),
): void {
  const environmentFile = path.resolve(workingDirectory, ".env");
  if (existsSync(environmentFile)) {
    loadEnvFile(environmentFile);
  }
}
