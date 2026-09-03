import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import { listMessages } from "./messages";

const ids = {
  user: "11111111-1111-4111-8111-111111111111",
  conversation: "22222222-2222-4222-8222-222222222222",
  message: "33333333-3333-4333-8333-333333333333",
};

function queryResult<T>(rows: T[]) {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

function messageReadFixture(kind: "pool" | "client") {
  const artifacts = Promise.withResolvers<ReturnType<typeof queryResult>>();
  let artifactsStarted = false;
  let attachmentsStarted = false;
  const query = vi.fn((sql: string) => {
    if (sql.includes("FROM messages m")) {
      return Promise.resolve(queryResult([
        {
          id: ids.message,
          run_id: null,
          role: "user",
          content: "Find buyers",
          citations: [],
          feedback: null,
          created_at: new Date("2026-08-27T08:00:00.000Z"),
        },
      ]));
    }
    if (sql.includes("FROM artifacts")) {
      artifactsStarted = true;
      return artifacts.promise;
    }
    if (sql.includes("FROM message_input_attachments")) {
      attachmentsStarted = true;
      return Promise.resolve(queryResult([]));
    }
    return Promise.reject(new Error(`Unexpected query: ${sql}`));
  });
  const database = kind === "client"
    ? ({ query, release: vi.fn() } as unknown as PoolClient)
    : ({ query } as unknown as Pool);

  return {
    artifacts,
    database,
    query,
    artifactsStarted: () => artifactsStarted,
    attachmentsStarted: () => attachmentsStarted,
  };
}

describe("listMessages query scheduling", () => {
  it("serializes related reads when using one PoolClient", async () => {
    const fixture = messageReadFixture("client");
    const resultPromise = listMessages(
      ids.user,
      ids.conversation,
      fixture.database,
    );

    await vi.waitFor(() => {
      expect(fixture.artifactsStarted()).toBe(true);
    });
    expect(fixture.attachmentsStarted()).toBe(false);

    fixture.artifacts.resolve(queryResult([]));
    await expect(resultPromise).resolves.toMatchObject([
      { id: ids.message, artifacts: [], attachments: [] },
    ]);
    expect(fixture.attachmentsStarted()).toBe(true);
  });

  it("keeps independent Pool reads parallel across checked-out clients", async () => {
    const fixture = messageReadFixture("pool");
    const resultPromise = listMessages(
      ids.user,
      ids.conversation,
      fixture.database,
    );

    await vi.waitFor(() => {
      expect(fixture.artifactsStarted()).toBe(true);
      expect(fixture.attachmentsStarted()).toBe(true);
    });

    fixture.artifacts.resolve(queryResult([]));
    await expect(resultPromise).resolves.toMatchObject([
      { id: ids.message, artifacts: [], attachments: [] },
    ]);
  });
});
