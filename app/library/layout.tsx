import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "资料库 · 外贸研究助手",
};

export default function LibraryLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return children;
}
