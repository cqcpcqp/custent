import {
  expect,
  test as base,
  type ConsoleMessage,
  type Page,
} from "@playwright/test";

type AutomaticFixtures = {
  browserRuntimeErrors: void;
  localRequestsOnly: void;
};

function formatConsoleError(message: ConsoleMessage): string {
  const location = message.location();
  const pageUrl = message.page()?.url() ?? "unknown page";
  const source =
    location.url.length === 0
      ? ""
      : `; source ${location.url}:${location.line + 1}:${location.column + 1}`;
  return `console.error on ${pageUrl}: ${message.text()}${source}`;
}

export const test = base.extend<AutomaticFixtures>({
  browserRuntimeErrors: [
    async ({ context }, use) => {
      const runtimeErrors: string[] = [];
      const monitoredPages = new Map<
        Page,
        {
          handleConsole: (message: ConsoleMessage) => void;
          handlePageError: (error: Error) => void;
        }
      >();
      const handlePage = (page: Page): void => {
        if (monitoredPages.has(page)) {
          return;
        }
        const handleConsole = (message: ConsoleMessage): void => {
          if (message.type() === "error") {
            runtimeErrors.push(formatConsoleError(message));
          }
        };
        const handlePageError = (error: Error): void => {
          const details = error.stack?.trim() ?? `${error.name}: ${error.message}`;
          runtimeErrors.push(`pageerror on ${page.url()}: ${details}`);
        };
        page.on("console", handleConsole);
        page.on("pageerror", handlePageError);
        monitoredPages.set(page, { handleConsole, handlePageError });
      };

      context.on("page", handlePage);
      for (const page of context.pages()) {
        handlePage(page);
      }

      await use();

      context.off("page", handlePage);
      for (const [page, { handleConsole, handlePageError }] of monitoredPages) {
        page.off("console", handleConsole);
        page.off("pageerror", handlePageError);
      }
      expect(
        runtimeErrors,
        "E2E pages must not emit console.error or uncaught page errors",
      ).toEqual([]);
    },
    { auto: true },
  ],
  localRequestsOnly: [
    async ({ baseURL, context }, use) => {
      if (baseURL === undefined) {
        throw new Error("Playwright baseURL is required");
      }
      const expectedOrigin = new URL(baseURL).origin;
      const forbiddenRequests: string[] = [];

      await context.route("**/*", async (route) => {
        const requestUrl = new URL(route.request().url());
        if (requestUrl.origin !== expectedOrigin) {
          forbiddenRequests.push(route.request().url());
          await route.abort("blockedbyclient");
          return;
        }
        await route.continue();
      });

      await use();

      expect(
        forbiddenRequests,
        "E2E browser traffic must remain on the isolated local Next server",
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
