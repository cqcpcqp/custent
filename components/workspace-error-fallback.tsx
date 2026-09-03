"use client";

import Link from "next/link";

import {
  AlertIcon,
  BrandMark,
  PlusIcon,
  RefreshIcon,
} from "@/components/icons";
import styles from "@/components/workspace-error-fallback.module.css";

export function WorkspaceErrorFallback({
  onRetry,
}: {
  onRetry: () => void;
}) {
  return (
    <main className={styles.screen}>
      <section
        aria-describedby="workspace-error-description"
        aria-labelledby="workspace-error-title"
        className={styles.card}
        role="alert"
      >
        <div aria-label="外贸研究助手" className={styles.brand}>
          <span className={styles.mark}>
            <BrandMark />
          </span>
          外贸研究助手
        </div>

        <span className={styles.statusIcon}>
          <AlertIcon />
        </span>
        <h1 id="workspace-error-title">工作区暂时无法显示</h1>
        <p id="workspace-error-description">
          界面在加载或渲染时遇到了意外问题。你可以重新尝试，或返回首页开始一项新研究。
        </p>

        <div className={styles.actions}>
          <button className={styles.primary} onClick={onRetry} type="button">
            <RefreshIcon />
            重新尝试
          </button>
          <Link className={styles.secondary} href="/">
            <PlusIcon />
            开始新研究
          </Link>
        </div>
      </section>
    </main>
  );
}

export const workspaceErrorDocumentClassName = styles.document;
