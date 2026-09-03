import {
  AccountCustomInstructionsSchema,
  type AccountCustomInstructions,
  type PutAccountCustomInstructionsRequest,
} from "@/lib/contracts";
import { getPool } from "@/lib/db/pool";
import type { Queryable } from "@/lib/db/types";
import { AppError } from "@/lib/errors";

type AccountCustomInstructionsRow = {
  custom_instructions_enabled: boolean;
  custom_instructions_content: string;
  custom_instructions_revision: number;
  custom_instructions_updated_at: Date;
};

type AccountCustomInstructionsUpdateRow = {
  account_id: string;
  custom_instructions_enabled: boolean | null;
  custom_instructions_content: string | null;
  custom_instructions_revision: number | null;
  custom_instructions_updated_at: Date | null;
};

export type UpdateAccountCustomInstructionsInput =
  PutAccountCustomInstructionsRequest & {
    userId: string;
  };

function mapAccountCustomInstructions(
  row: AccountCustomInstructionsRow,
): AccountCustomInstructions {
  return AccountCustomInstructionsSchema.parse({
    enabled: row.custom_instructions_enabled,
    content: row.custom_instructions_content,
    revision: row.custom_instructions_revision,
    updatedAt: row.custom_instructions_updated_at.toISOString(),
  });
}

export async function getAccountCustomInstructions(
  userId: string,
  database: Queryable = getPool(),
): Promise<AccountCustomInstructions> {
  const result = await database.query<AccountCustomInstructionsRow>(
    `
      SELECT
        custom_instructions_enabled,
        custom_instructions_content,
        custom_instructions_revision,
        custom_instructions_updated_at
      FROM users
      WHERE id = $1
    `,
    [userId],
  );

  if (result.rowCount !== 1) {
    throw new AppError("NOT_FOUND", "User was not found", 404);
  }

  return mapAccountCustomInstructions(result.rows[0]);
}

export async function updateAccountCustomInstructions(
  input: UpdateAccountCustomInstructionsInput,
  database: Queryable = getPool(),
): Promise<AccountCustomInstructions> {
  const result = await database.query<AccountCustomInstructionsUpdateRow>(
    `
      WITH account AS MATERIALIZED (
        SELECT id
        FROM users
        WHERE id = $1
      ), updated AS (
        UPDATE users target
        SET
          custom_instructions_enabled = $2,
          custom_instructions_content = $3,
          custom_instructions_revision =
            target.custom_instructions_revision + 1,
          custom_instructions_updated_at = now()
        FROM account
        WHERE
          target.id = account.id
          AND target.custom_instructions_revision = $4
        RETURNING
          target.custom_instructions_enabled,
          target.custom_instructions_content,
          target.custom_instructions_revision,
          target.custom_instructions_updated_at
      )
      SELECT
        account.id AS account_id,
        updated.custom_instructions_enabled,
        updated.custom_instructions_content,
        updated.custom_instructions_revision,
        updated.custom_instructions_updated_at
      FROM account
      LEFT JOIN updated ON true
    `,
    [input.userId, input.enabled, input.content, input.expectedRevision],
  );

  if (result.rowCount === 0) {
    throw new AppError("NOT_FOUND", "User was not found", 404);
  }

  const row = result.rows[0];
  if (row.custom_instructions_enabled === null) {
    throw new AppError(
      "CUSTOM_INSTRUCTIONS_REVISION_CONFLICT",
      "自定义指令已在其他页面更新，请刷新后重试。",
      409,
    );
  }
  if (
    row.custom_instructions_content === null ||
    row.custom_instructions_revision === null ||
    row.custom_instructions_updated_at === null
  ) {
    throw new TypeError("Updated custom instructions fields are inconsistent");
  }

  return mapAccountCustomInstructions({
    custom_instructions_enabled: row.custom_instructions_enabled,
    custom_instructions_content: row.custom_instructions_content,
    custom_instructions_revision: row.custom_instructions_revision,
    custom_instructions_updated_at: row.custom_instructions_updated_at,
  });
}
