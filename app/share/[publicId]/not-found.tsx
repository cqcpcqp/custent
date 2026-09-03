import Link from "next/link";

import { BrandMark, ShareIcon } from "@/components/icons";

export default function PublicConversationShareNotFound() {
  return (
    <main className="shared-conversation-page shared-conversation-page--not-found">
      <section aria-labelledby="shared-conversation-not-found-title">
        <span className="shared-conversation-not-found__mark">
          <BrandMark />
        </span>
        <span className="shared-conversation-not-found__eyebrow">
          <ShareIcon />
          只读分享
        </span>
        <h1 id="shared-conversation-not-found-title">这个分享链接不可用</h1>
        <p>链接可能不存在、已被撤销，或原对话已被删除。</p>
        <Link href="/">返回外贸研究助手</Link>
      </section>
    </main>
  );
}
