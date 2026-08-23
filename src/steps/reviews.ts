import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { track, type Spend } from "../cost.js";
import { REVIEW_SYSTEM, reviewUser } from "../prompts.js";
import {
  anthropicClient,
  assertNotRefused,
  fromAnthropic,
  requestOptionsFor,
} from "../providers/anthropic.js";
import { serperKey, serperSearch, type SerperHit } from "../providers/serper.js";
import { ReviewFinding, type Consolidated } from "../types.js";

type Competitor = Consolidated["competitors"][number];
export type ReviewResult = ReviewFinding & { competitor: string; queries: string[] };

/** 검색 결과 URL이 사용자 목소리가 담길 만한 곳인지. 자사 도메인 스니펫을 걸러내는 데 쓴다. */
const USER_VOICE = /reddit\.com|news\.ycombinator|youtube\.com|apps\.apple\.com|play\.google\.com|facebook\.com|g2\.com|capterra\.com|trustpilot\.com|producthunt\.com/i;

/**
 * 경쟁사 하나에 대한 검색어를 만든다. LLM을 쓰지 않는다 —
 * 리뷰 검색은 패턴이 정해져 있어서 규칙으로 충분하고, 경쟁사 수만큼 호출이 늘어나면 비용이 커진다.
 *
 * 도메인 맥락(category)을 반드시 붙인다. 제품명만으로 검색하면 동명이인에 걸린다 —
 * 실측 예: 임상시험 소프트웨어 "CRIO"를 이름만으로 검색하니 인도 코딩 부트캠프 "Crio.Do"가 전부 나왔다.
 */
function reviewQueries(c: Competitor, category: string): string[] {
  const name = c.name.replace(/\s*[—–(].*$/, "").trim(); // "제품 — 부제", "제품 (설명)"에서 제품명만
  const queries = [
    `${name} ${category} review`,
    `${name} ${category} reddit`,
    `"${name}" ${category} complaints OR problems`,
  ];

  // 리뷰가 어디 있는지는 앞 단계가 이미 알아냈다. 그 소스를 조준한다.
  if (c.review_sources.some((s) => /app_store|play_store/.test(s))) {
    queries.push(`${name} app review rating`);
  }
  if (c.review_sources.some((s) => /youtube/.test(s))) {
    queries.push(`${name} ${category} review youtube`);
  }
  return queries;
}

async function analyzeOne(
  c: Competitor,
  spend: Spend,
  opts: { model: string; category: string },
): Promise<ReviewResult> {
  const apiKey = serperKey();
  const queries = reviewQueries(c, opts.category);

  const settled = await Promise.allSettled(queries.map((q) => serperSearch(apiKey, q)));
  const results: { query: string; hits: SerperHit[] }[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      // 자사 도메인 결과는 마케팅 문구라 사용자 목소리가 아니다. 미리 걸러 토큰을 아낀다.
      const hits = r.value.filter((h) => USER_VOICE.test(h.url));
      results.push({ query: queries[i]!, hits });
    }
  });

  const totalHits = results.reduce((n, r) => n + r.hits.length, 0);
  if (totalHits === 0) {
    return {
      competitor: c.name,
      queries,
      strengths: [],
      weaknesses: [],
      sentiment: "insufficient",
      evidence_count: 0,
      note: `사용자 목소리가 담긴 검색 결과를 찾지 못함 (검색어 ${queries.length}개 실행)`,
    };
  }

  const MAX_TOKENS = 8000;
  const res = await anthropicClient().beta.messages.parse({
    model: opts.model,
    max_tokens: MAX_TOKENS,
    ...requestOptionsFor(opts.model, MAX_TOKENS),
    system: REVIEW_SYSTEM,
    messages: [{ role: "user", content: reviewUser(c.name, c.one_liner, results) }],
    output_config: { format: betaZodOutputFormat(ReviewFinding) },
  });

  assertNotRefused(res, `reviews:${c.name}`);
  track(spend, "reviews", opts.model, fromAnthropic(res.usage));

  if (!res.parsed_output) {
    return {
      competitor: c.name,
      queries,
      strengths: [],
      weaknesses: [],
      sentiment: "insufficient",
      evidence_count: 0,
      note: "구조화 출력 파싱 실패",
    };
  }
  return { competitor: c.name, queries, ...res.parsed_output };
}

/**
 * 리뷰 분석 대상을 고른다.
 * 전체를 돌리면 비용이 경쟁사 수에 비례해 늘어나는데, 창업자가 실제로 궁금한 건 가까운 경쟁사다.
 * traction이 none인 것은 실존조차 불확실해서 리뷰가 있을 리 없다.
 */
export function pickReviewTargets(competitors: Competitor[], top: number): Competitor[] {
  const RANK = { direct: 0, adjacent: 1, substitute: 2, unclear: 3 } as const;
  return competitors
    .filter((c) => c.traction !== "none")
    .sort((a, b) => {
      const byRel = RANK[a.relation] - RANK[b.relation];
      if (byRel !== 0) return byRel;
      // 같은 관계면 실사용 흔적이 확인된 쪽을 먼저 — 리뷰가 있을 가능성이 높다
      return (a.traction === "confirmed" ? 0 : 1) - (b.traction === "confirmed" ? 0 : 1);
    })
    .slice(0, top);
}

export async function analyzeReviews(
  targets: Competitor[],
  spend: Spend,
  opts: { model: string; category: string; onProgress?: (r: ReviewResult) => void },
): Promise<ReviewResult[]> {
  const out: ReviewResult[] = [];
  // 한 번에 4개씩. Serper 스로틀과 별개로 Anthropic 쪽 동시 호출도 묶어둔다.
  const BATCH = 4;
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = await Promise.all(
      targets.slice(i, i + BATCH).map((c) => analyzeOne(c, spend, { model: opts.model, category: opts.category })),
    );
    for (const r of batch) {
      out.push(r);
      opts.onProgress?.(r);
    }
  }
  return out;
}
