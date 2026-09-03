import type { CreditBalance } from "@/lib/contracts";
import { AppError } from "@/lib/errors";

import { getPool } from "./pool";
import type { Queryable } from "./types";

export type AccountUser = {
  id: string;
  name: string;
};

type AccountUserRow = {
  id: string;
  name: string;
  available_credits: number;
  reserved_credits: number;
  frozen_credits: number;
};

export async function getUserAccount(
  userId: string,
  database: Queryable = getPool(),
): Promise<{ user: AccountUser; credits: CreditBalance }> {
  const result = await database.query<AccountUserRow>(
    `
      SELECT id, name, available_credits, reserved_credits, frozen_credits
      FROM users
      WHERE id = $1
    `,
    [userId],
  );

  if (result.rowCount !== 1) {
    throw new AppError("NOT_FOUND", "Demo user was not found", 404);
  }

  const row = result.rows[0];
  return {
    user: { id: row.id, name: row.name },
    credits: {
      available: row.available_credits,
      reserved: row.reserved_credits + row.frozen_credits,
    },
  };
}
