import { pricingFor } from "./providers/registry.js";
import type { Usage } from "./providers/types.js";

export const STAGES = ["refine", "search", "extract", "consolidate", "reviews", "positioning"] as const;
export type Stage = (typeof STAGES)[number];

export type StageSpend = {
  model: string;
  calls: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  webSearches: number;
  /** 프로바이더가 직접 계산한 검색 툴 요금 합계. */
  searchCost: number;
  /** 검색 요금을 프로바이더가 직접 알려줬는가 */
  searchCostIsReported: boolean;
  /** 프로바이더가 보고한 실제 청구액 합계. 0이면 보고받지 못한 것이다. */
  reportedCost: number;
  /** 단가표 추정 대신 실측값을 쓰고 있는가 */
  costIsReported: boolean;
};

export type Spend = Record<Stage, StageSpend>;

const blank = (): StageSpend => ({
  model: "",
  calls: 0,
  input: 0,
  output: 0,
  cacheWrite: 0,
  cacheRead: 0,
  webSearches: 0,
  searchCost: 0,
  searchCostIsReported: false,
  reportedCost: 0,
  costIsReported: false,
});

export const newSpend = (): Spend => ({
  refine: blank(),
  search: blank(),
  extract: blank(),
  consolidate: blank(),
  reviews: blank(),
  positioning: blank(),
});

/** 응답 하나의 usage를 해당 단계에 누적한다. */
export function track(spend: Spend, stage: Stage, model: string, usage: Usage | undefined): void {
  if (!usage) return;
  const s = spend[stage];
  s.model = model;
  s.calls += 1;
  s.input += usage.input;
  s.output += usage.output;
  s.cacheWrite += usage.cacheWrite ?? 0;
  s.cacheRead += usage.cacheRead ?? 0;
  s.webSearches += usage.webSearches ?? 0;
  if (usage.searchCostUsd !== undefined) {
    s.searchCost += usage.searchCostUsd;
    s.searchCostIsReported = true;
  }
  if (usage.reportedCostUsd !== undefined) {
    s.reportedCost += usage.reportedCostUsd;
    s.costIsReported = true;
  }
}

/** 토큰 + 웹서치 툴 요금을 합친 실제 비용. */
export function costOf(s: StageSpend): number {
  if (!s.calls) return 0;
  // 프로바이더가 실제 청구액을 알려줬으면 추정하지 않는다.
  if (s.costIsReported) return s.reportedCost;
  const p = pricingFor(s.model);
  const tokens =
    (s.input * p.input +
      s.cacheWrite * p.input * 1.25 +
      s.cacheRead * p.input * 0.1 +
      s.output * p.output) /
    1e6;
  const search = s.searchCostIsReported ? s.searchCost : (s.webSearches * p.searchPer1k) / 1000;
  return tokens + search;
}

export function totalCost(spend: Spend): number {
  return STAGES.reduce((sum, st) => sum + costOf(spend[st]), 0);
}

/** 단계별 비용 분해 표. 어디에 돈이 쓰였는지 한눈에 보라고 만든 것이다. */
export function formatSpendTable(spend: Spend): string {
  const total = totalCost(spend);
  const tok = (n: number) => (n === 0 ? "-" : `${(n / 1000).toFixed(1)}k`);
  const rows = STAGES.filter((st) => spend[st].calls > 0).map((st) => {
    const s = spend[st];
    const cost = costOf(s);
    const share = total > 0 ? ((cost / total) * 100).toFixed(0) : "0";
    return [
      `  ${st.padEnd(12)}`,
      s.model.replace("claude-", "").padEnd(10),
      `${String(s.calls).padStart(2)}콜`,
      `in ${tok(s.input).padStart(7)}`,
      `out ${tok(s.output).padStart(6)}`,
      `검색 ${String(s.webSearches).padStart(2)}`,
      `$${cost.toFixed(3).padStart(6)}${s.costIsReported ? "*" : " "}`,
      `${share.padStart(3)}%`,
    ].join("  ");
  });
  const searches = STAGES.reduce((n, st) => n + spend[st].webSearches, 0);
  return [
    "",
    "  단계별 비용 (토큰 + 웹서치 툴 요금)",
    "  " + "─".repeat(84),
    ...rows,
    "  " + "─".repeat(84),
    `  ${"합계".padEnd(11)}${" ".repeat(30)}웹서치 ${searches}회${" ".repeat(20)}$${total.toFixed(3)}`,
    STAGES.some((st) => spend[st].costIsReported)
      ? "  * 프로바이더가 보고한 실측 청구액 (나머지는 단가표 기반 추정)"
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
