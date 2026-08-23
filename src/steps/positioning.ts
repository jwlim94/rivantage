import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { track, type Spend } from "../cost.js";
import { POSITIONING_SYSTEM, positioningUser } from "../prompts.js";
import {
  anthropicClient,
  assertNotRefused,
  fromAnthropic,
  requestOptionsFor,
} from "../providers/anthropic.js";
import { PositioningMap, type Consolidated, type RefinedIdea } from "../types.js";
import type { ReviewResult } from "./reviews.js";

type Competitor = Consolidated["competitors"][number];

/**
 * 지도에 올릴 경쟁사를 고른다.
 *
 * substitute(엑셀 템플릿, 프리랜서)는 축 위에 놓기 어렵다 — 제품이 아니라 대체 경로라서
 * 같은 축으로 비교하면 지도가 흐려진다. 다만 "무료" 쪽 끝을 보여주는 값이 있으므로
 * traction이 확인된 것만 소수 남긴다.
 */
export function pickPositioningTargets(competitors: Competitor[], limit: number): Competitor[] {
  const core = competitors.filter((c) => c.relation === "direct" || c.relation === "adjacent");
  const freeEnd = competitors
    .filter((c) => c.relation === "substitute" && c.traction === "confirmed")
    .slice(0, 3);

  const RANK = { direct: 0, adjacent: 1, substitute: 2, unclear: 3 } as const;
  return [...core, ...freeEnd]
    .filter((c) => c.traction !== "none")
    .sort((a, b) => RANK[a.relation] - RANK[b.relation])
    .slice(0, limit);
}

export async function mapPositioning(
  refined: RefinedIdea,
  competitors: Competitor[],
  reviews: ReviewResult[],
  spend: Spend,
  opts: { model: string },
): Promise<PositioningMap> {
  const reviewSummaries = reviews
    .filter((r) => r.sentiment !== "insufficient")
    .map((r) => ({
      competitor: r.competitor,
      strengths: r.strengths.map((s) => s.point),
      weaknesses: r.weaknesses.map((w) => w.point),
    }));

  const MAX_TOKENS = 16000;
  const res = await anthropicClient().beta.messages.parse({
    model: opts.model,
    max_tokens: MAX_TOKENS,
    ...requestOptionsFor(opts.model, MAX_TOKENS),
    system: POSITIONING_SYSTEM,
    messages: [
      {
        role: "user",
        content: positioningUser(
          refined,
          competitors.map((c) => ({
            name: c.name,
            one_liner: c.one_liner,
            relation: c.relation,
            size_hint: c.size_hint,
            traction: c.traction,
            why_competitor: c.why_competitor,
          })),
          reviewSummaries,
        ),
      },
    ],
    output_config: { format: betaZodOutputFormat(PositioningMap) },
  });

  assertNotRefused(res, "positioning");
  track(spend, "positioning", opts.model, fromAnthropic(res.usage));

  if (!res.parsed_output) throw new Error("[positioning] 구조화 출력 파싱 실패");
  return res.parsed_output;
}

/** 축 위 위치를 한 줄짜리 눈금으로 그린다. 표보다 지형이 눈에 들어온다. */
export function renderAxis(position: string): string {
  const slot = { low: 0, mid: 1, high: 2 }[position];
  if (slot === undefined) return "  ?  ";
  return ["●──┬──┬", "┬──●──┬", "┬──┬──●"][slot]!;
}
