import {
  ChartIcon,
  DocumentIcon,
  GlobeIcon,
  PeopleIcon,
} from "@/components/icons";

type ResearchEmptyStateProps = {
  userName: string;
  onUsePrompt: (prompt: string) => void;
};

const prompts = [
  {
    title: "寻找目标公司",
    description: "按市场、客户类型和产品匹配潜在买家",
    prompt: "我们生产工业阀门，请帮我寻找德国的进口商和经销商，并说明匹配依据。",
    icon: GlobeIcon,
    tone: "green",
  },
  {
    title: "研究关键联系人",
    description: "定位采购、品类、供应链等业务相关角色",
    prompt: "请研究目标公司中与采购和产品决策相关的联系人，并给出公开来源。",
    icon: PeopleIcon,
    tone: "blue",
  },
  {
    title: "分析海外市场",
    description: "梳理市场规模、渠道结构和竞争动向",
    prompt: "帮我分析目标产品在欧洲市场的主要销售渠道、买家类型和近期行业趋势。",
    icon: ChartIcon,
    tone: "amber",
  },
  {
    title: "整理研究报告",
    description: "把当前结果整理成 CSV 或带引用的 PDF",
    prompt: "请把当前研究结果整理成结构清晰的 CSV，并生成一份带来源引用的 PDF 摘要。",
    icon: DocumentIcon,
    tone: "violet",
  },
] as const;

export function ResearchEmptyState({
  userName,
  onUsePrompt,
}: ResearchEmptyStateProps) {
  return (
    <section className="empty-state">
      <div className="empty-state__eyebrow">
        <span />
        <strong>RESEARCH WORKSPACE</strong>
        <span />
      </div>
      <h1>
        你好，{userName}
        <br />
        今天想研究什么？
      </h1>
      <p>
        从一个产品、一类客户或一个市场开始。我会检索公开信息、保留引用，
        并按需整理成可下载的研究文件。
      </p>
      <div className="prompt-grid">
        {prompts.map((item) => {
          const Icon = item.icon;
          return (
            <button
              className="prompt-card"
              key={item.title}
              onClick={() => onUsePrompt(item.prompt)}
              type="button"
            >
              <span
                className={`prompt-card__icon prompt-card__icon--${item.tone}`}
              >
                <Icon />
              </span>
              <span className="prompt-card__copy">
                <strong>{item.title}</strong>
                <small>{item.description}</small>
              </span>
              <span className="prompt-card__arrow" aria-hidden="true">
                ↗
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
