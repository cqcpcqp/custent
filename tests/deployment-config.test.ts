import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const read = (filename: string) =>
  readFileSync(path.join(root, filename), "utf8");

describe("restricted deployment configuration", () => {
  it("keeps shell entrypoints syntactically valid", () => {
    for (const filename of ["deploy/deploy.sh", "deploy/bootstrap.sh"]) {
      expect(() => execFileSync("bash", ["-n", path.join(root, filename)]))
        .not.toThrow();
    }
  });

  it("allows only the confirmed client and local probes, without trusting forwarded IPs", () => {
    const nginx = read("deploy/nginx.conf");
    expect(nginx.match(/allow [^;]+;/gu)).toEqual([
      "allow 223.166.95.113;",
      "allow 127.0.0.1;",
    ]);
    expect(nginx).toContain("deny all;");
    expect(nginx).toContain("listen 8081 default_server;");
    expect(nginx).not.toMatch(/real_ip_header|set_real_ip_from|proxy_add_x_forwarded_for/u);
    expect(nginx).toContain("proxy_set_header X-Forwarded-For $remote_addr;");
    expect(nginx).toContain("proxy_buffering off;");
    expect(nginx).toContain("/maintenance/enabled");
  });

  it("does not publish the database or expose the application directly", () => {
    const compose = read("deploy/compose.yml");
    expect(compose.match(/ports:/gu)).toHaveLength(1);
    expect(compose).toContain('"127.0.0.1:3000:3000"');
    expect(compose).toContain("network_mode: host");
    expect(compose).not.toContain("8080");
    expect(compose).toContain("format: raw");
    expect(compose).toContain("scripts/agent-worker.ts");
    expect(compose).toContain("scripts/run-reaper.ts");
    expect(compose).toContain("scripts/input-attachment-worker.ts");
  });

  it("excludes environment files and persisted data from images", () => {
    const ignored = read(".dockerignore").split("\n");
    expect(ignored).toEqual(expect.arrayContaining([".env", ".env.*", ".data", ".git"]));
    expect(read("Dockerfile")).toContain("pnpm install --frozen-lockfile");
    expect(read("Dockerfile")).toContain("USER node");
  });

  it("drains and backs up before migration, then reopens only after checks", () => {
    const script = read("deploy/deploy.sh");
    const stages = [
      'touch "$root/shared/maintenance/enabled"',
      'stop --timeout 30 web',
      "SELECT count(*) FROM runs",
      "stop --timeout 30 worker reaper attachments",
      "pg_dump",
      "files.tar.gz",
      "run --rm --no-deps migrate",
      "up -d --wait --wait-timeout 180 web",
      "http://127.0.0.1:3000/api/bootstrap",
      'rm -- "$root/shared/maintenance/enabled"',
    ];
    const positions = stages.map((stage) => script.indexOf(stage));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(script).toContain("flock -n 9");
    expect(script).toContain("--password-stdin");
    expect(script).toContain("--no-recreate");
    expect(script).not.toContain("down --volumes");
  });

  it("serializes deployments, verifies SSH hosts and runs database tests without browsers", () => {
    const workflow = read(".github/workflows/deploy.yml");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("StrictHostKeyChecking=yes");
    expect(workflow).toContain("TEST_DATABASE_URL:");
    expect(workflow).toContain("pnpm db:migrate");
    expect(workflow).toContain("pnpm check");
    expect(workflow).toContain("Skipping superseded commit");
    expect(workflow).not.toMatch(/pnpm e2e|playwright install|StrictHostKeyChecking=no/u);
    for (const match of workflow.matchAll(/uses: (.+)/gu)) {
      expect(match[1]).toMatch(/@[a-f0-9]{40}$/u);
    }
  });
});
