import type { Metadata } from "next";
import Script from "next/script";
import "@fontsource/noto-sans-sc/400.css";
import "@fontsource/noto-sans-sc/500.css";
import "@fontsource/noto-sans-sc/600.css";
import "@fontsource/noto-sans-sc/700.css";
import { ThemeProvider } from "@/components/theme-provider";
import { themeInitializationScript } from "@/components/theme-state";
import { WorkspaceRouteShell } from "@/components/workspace-route-shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "外贸研究助手",
  description: "面向外贸团队的智能研究工作台",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      data-theme="light"
      data-theme-preference="system"
      lang="zh-CN"
      suppressHydrationWarning
    >
      <body>
        <Script
          dangerouslySetInnerHTML={{ __html: themeInitializationScript }}
          id="custent-theme-initializer"
          strategy="beforeInteractive"
        />
        <ThemeProvider>
          <WorkspaceRouteShell>{children}</WorkspaceRouteShell>
        </ThemeProvider>
      </body>
    </html>
  );
}
