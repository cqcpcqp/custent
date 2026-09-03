import { ZodError } from "zod";

import type { ApiErrorResponse } from "@/lib/contracts";
import { AppError } from "@/lib/errors";

export function errorResponse(error: unknown): Response {
  if (error instanceof AppError) {
    return Response.json(
      { error: { code: error.code, message: error.message } } satisfies ApiErrorResponse,
      { status: error.status },
    );
  }

  if (error instanceof ZodError || error instanceof SyntaxError) {
    return Response.json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: "请求内容不符合接口约定。",
        },
      } satisfies ApiErrorResponse,
      { status: 400 },
    );
  }

  console.error(error);
  return Response.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "服务暂时无法完成这个请求，请稍后重试。",
      },
    } satisfies ApiErrorResponse,
    { status: 500 },
  );
}
