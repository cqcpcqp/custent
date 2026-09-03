import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import {
  collectCleanupFailures,
  installShutdownSignalHandlers,
  observeNextServer,
  parseInspectionDurationMs,
  stopChild,
  waitForInspectionDuration,
} from "./e2e";

class FakeSignalTarget extends EventEmitter {
  exitCode: NodeJS.Process["exitCode"] = undefined;
}

async function waitForWrapperChildPid(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Wrapper child did not become ready: ${output}`));
    }, 3_000);
    const handleData = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      const match = /WRAPPER_CHILD_READY:(\d+)/u.exec(output);
      if (match === null) {
        return;
      }
      cleanup();
      resolve(Number(match[1]));
    };
    const handleExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      cleanup();
      reject(
        new Error(
          `Wrapper exited before its child was ready with ${
            code === null ? `signal ${signal}` : `code ${code}`
          }: ${output}`,
        ),
      );
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout?.removeListener("data", handleData);
      child.stderr?.removeListener("data", handleData);
      child.removeListener("exit", handleExit);
    };

    child.stdout?.on("data", handleData);
    child.stderr?.on("data", handleData);
    child.once("exit", handleExit);
  });
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await delay(20);
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function fakeChildProcess(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    exitCode: null,
    kill: () => true,
    pid: 123,
    signalCode: null,
  }) as unknown as ChildProcess;
}

describe("E2E inspection duration", () => {
  it("accepts only complete decimal integers in the documented range", () => {
    expect(parseInspectionDurationMs(undefined)).toBe(0);
    expect(parseInspectionDurationMs("0")).toBe(0);
    expect(parseInspectionDurationMs("1")).toBe(1);
    expect(parseInspectionDurationMs("600000")).toBe(600_000);

    for (const invalid of [
      "",
      "00",
      " 1",
      "1 ",
      "+1",
      "-1",
      "1.9",
      "1e3",
      "1000oops",
      "600001",
    ]) {
      expect(() => parseInspectionDurationMs(invalid)).toThrow(
        "CUSTENT_E2E_INSPECT_MS must be an integer from 0 to 600000",
      );
    }
  });

  it("aborts an active inspection delay with the original reason", async () => {
    const shutdown = new AbortController();
    const reason = new Error("test interruption");
    const waiting = waitForInspectionDuration(60_000, shutdown.signal);

    shutdown.abort(reason);

    await expect(waiting).rejects.toBe(reason);
  });
});

describe("E2E process signals", () => {
  it("keeps consuming duplicate wrapper signals until cleanup disposes it", () => {
    const shutdown = new AbortController();
    const target = new FakeSignalTarget();
    const handlers = installShutdownSignalHandlers(shutdown, target);

    target.emit("SIGINT");
    const firstReason = shutdown.signal.reason;
    target.emit("SIGINT");
    target.emit("SIGTERM");

    expect(shutdown.signal.aborted).toBe(true);
    expect(firstReason).toMatchObject({ message: "E2E interrupted by SIGINT" });
    expect(shutdown.signal.reason).toBe(firstReason);
    expect(target.exitCode).toBe(130);
    expect(target.listenerCount("SIGINT")).toBe(1);
    expect(target.listenerCount("SIGTERM")).toBe(1);

    handlers.dispose();

    expect(target.listenerCount("SIGINT")).toBe(0);
    expect(target.listenerCount("SIGTERM")).toBe(0);
  });

  it(
    "finishes asynchronous cleanup after duplicate signals cross a pnpm wrapper",
    async () => {
      const projectPackage = JSON.parse(
        await readFile(
          path.resolve(import.meta.dirname, "..", "package.json"),
          "utf8",
        ),
      ) as { scripts: { e2e: string } };
      expect(projectPackage.scripts.e2e).toBe(
        "node --import tsx scripts/e2e.ts",
      );
      const temporaryDirectory = await mkdtemp(
        path.join(tmpdir(), "custent-e2e-signal-wrapper-"),
      );
      const markerPath = path.join(temporaryDirectory, "cleaned");
      const fixturePath = path.join(temporaryDirectory, "signal-child.mts");
      const e2eModuleUrl = new URL("./e2e.ts", import.meta.url).href;
      const tsxImportUrl = import.meta.resolve("tsx");
      await writeFile(
        fixturePath,
        [
          'import { writeFile } from "node:fs/promises";',
          'import { setTimeout as delay } from "node:timers/promises";',
          `import { installShutdownSignalHandlers } from ${JSON.stringify(e2eModuleUrl)};`,
          "const shutdown = new AbortController();",
          "const handlers = installShutdownSignalHandlers(shutdown);",
          'console.log(`WRAPPER_CHILD_READY:${process.pid}`);',
          "await new Promise((resolve) => shutdown.signal.addEventListener(\"abort\", resolve, { once: true }));",
          "await delay(150);",
          `await writeFile(${JSON.stringify(markerPath)}, "cleaned", "utf8");`,
          "handlers.dispose();",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        path.join(temporaryDirectory, "package.json"),
        JSON.stringify({
          private: true,
          type: "module",
          scripts: {
            e2e: `"${process.execPath}" --import "${tsxImportUrl}" signal-child.mts`,
          },
        }),
        "utf8",
      );

      const wrapper = spawn(
        "pnpm",
        ["--dir", temporaryDirectory, "e2e"],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const wrapperExit = once(wrapper, "exit");
      let fixturePid: number | null = null;
      try {
        fixturePid = await waitForWrapperChildPid(wrapper);
        process.kill(fixturePid, "SIGINT");
        wrapper.kill("SIGINT");
        await delay(20);
        process.kill(fixturePid, "SIGINT");

        await waitForFile(markerPath);
        const [code, signal] = await wrapperExit;
        expect(signal).toBeNull();
        expect(code).toBe(130);
      } finally {
        if (wrapper.exitCode === null && wrapper.signalCode === null) {
          wrapper.kill("SIGKILL");
          await once(wrapper, "exit");
        }
        if (fixturePid !== null) {
          try {
            process.kill(fixturePid, "SIGKILL");
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !("code" in error) ||
              error.code !== "ESRCH"
            ) {
              throw error;
            }
          }
        }
        await rm(temporaryDirectory, { force: true, recursive: true });
      }
    },
    10_000,
  );
});

describe("E2E cleanup collection", () => {
  it("runs every task and preserves every cleanup failure", async () => {
    const calls: string[] = [];
    const firstFailure = new Error("first cleanup failed");
    const secondFailure = new Error("second cleanup failed");

    const failures = await collectCleanupFailures([
      {
        label: "run the first cleanup",
        run: async () => {
          calls.push("first");
          throw firstFailure;
        },
      },
      {
        label: "run the successful cleanup",
        run: async () => {
          calls.push("success");
        },
      },
      {
        label: "run the second cleanup",
        run: async () => {
          calls.push("second");
          throw secondFailure;
        },
      },
    ]);

    expect(calls).toEqual(["first", "success", "second"]);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({ cause: firstFailure });
    expect(failures[1]).toMatchObject({ cause: secondFailure });
  });
});

describe("Next E2E server lifecycle", () => {
  it("turns an unexpected exit into the shared shutdown reason", () => {
    const shutdown = new AbortController();
    const child = fakeChildProcess();
    const lifecycle = observeNextServer(child, shutdown);

    child.emit("exit", 23, null);

    expect(shutdown.signal.aborted).toBe(true);
    expect(shutdown.signal.reason).toMatchObject({
      message: "Next E2E server exited unexpectedly with code 23",
    });
    expect(lifecycle.getUnexpectedFailure()).toBe(shutdown.signal.reason);
    lifecycle.dispose();
  });

  it("does not report the exit produced by stopChild", async () => {
    const shutdown = new AbortController();
    const child = fakeChildProcess();
    child.kill = ((signal: NodeJS.Signals = "SIGTERM") => {
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    }) as ChildProcess["kill"];
    const lifecycle = observeNextServer(child, shutdown);

    await stopChild(child, lifecycle);

    expect(shutdown.signal.aborted).toBe(false);
    expect(lifecycle.getUnexpectedFailure()).toBeNull();
    lifecycle.dispose();
  });

  it(
    "consumes spawn ENOENT and stops without waiting for a missing exit event",
    async () => {
      const shutdown = new AbortController();
      const child = spawn(
        path.join(tmpdir(), `custent-e2e-missing-${randomUUID()}`),
        [],
        { signal: shutdown.signal },
      );
      const lifecycle = observeNextServer(child, shutdown);

      await once(child, "error");

      expect(shutdown.signal.aborted).toBe(true);
      await expect(stopChild(child, lifecycle)).resolves.toBeUndefined();
      lifecycle.dispose();
    },
    1_000,
  );
});
