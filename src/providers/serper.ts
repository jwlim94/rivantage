import { SEARCH_FROM_RESULTS_SYSTEM, searchFromResultsUser } from "../prompts.js";
import {
  anthropicClient,
  assertNotRefused,
  fromAnthropic,
  requestOptionsFor,
} from "./anthropic.js";
import { requireEnv, type AngleFindings, type SearchProvider, type Usage } from "./types.js";

/**
 * 검색을 직접 조달하는 경로.
 *
 * 서버사이드 웹서치(Anthropic/Grok)는 모델이 페이지를 열어 읽고 그 내용을 컨텍스트에 계속 쌓는다.
 * 그래서 input이 폭증하고(실측 460.9k) 시간이 오래 걸린다.
 * 여기서는 검색을 우리가 하고 **스니펫만** 모델에 넘긴다 — input을 우리가 통제하게 된다.
 *
 * 대가: 모델이 페이지 본문을 못 본다. 스니펫에 안 드러나는 제품은 판단 근거가 얇아진다.
 */
const SERPER_URL = "https://google.serper.dev/search";

/** Serper 가격($0.30/1k)은 번들에 따라 달라진다. 실제 요금제에 맞게 고칠 것. */
const SERPER_PER_QUERY = 0.3 / 1000;

/** 검색어 하나당 가져올 결과 수. 늘리면 input이 그만큼 늘어난다. */
const RESULTS_PER_QUERY = 10;

/**
 * Serper는 초당 5요청까지만 받는다.
 * 각도 4개가 병렬로 돌고 각 각도가 쿼리 여러 개를 던지므로, 전역으로 간격을 둬야 한다.
 * (각도별로만 제한하면 각도끼리 겹쳐서 여전히 429가 난다.)
 */
const MIN_INTERVAL_MS = 320; // 슬라이딩 윈도우 기준 약 3.9 req/s — 상한 5에 여유를 둔다
let nextSlot = 0;

async function throttle(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + MIN_INTERVAL_MS;
  const wait = slot - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

type SerperHit = { title: string; url: string; snippet: string };

async function serperSearch(apiKey: string, query: string, attempt = 0): Promise<SerperHit[]> {
  await throttle();

  const res = await fetch(SERPER_URL, {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num: RESULTS_PER_QUERY }),
  });

  // 429는 검색 하나를 통째로 잃는다는 뜻이라 재시도할 가치가 있다. 크레딧도 차감되지 않는다.
  if (res.status === 429 && attempt < 3) {
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    return serperSearch(apiKey, query, attempt + 1);
  }

  if (!res.ok) {
    throw new Error(`[serper] ${res.status} ${res.statusText}: ${await res.text().catch(() => "")}`);
  }

  const body = (await res.json()) as { organic?: { title?: string; link?: string; snippet?: string }[] };
  return (body.organic ?? [])
    .filter((o): o is { title: string; link: string; snippet?: string } => typeof o.link === "string")
    .map((o) => ({ title: o.title ?? "", url: o.link, snippet: o.snippet ?? "" }));
}

export const serperProvider: SearchProvider = {
  name: "serper",
  // 검색은 Serper가, 판단은 Claude가 한다. 이 모델은 후자를 가리킨다.
  defaultSearchModel: "claude-haiku-4-5",
  requiredEnv: "SERPER_API_KEY",
  consoleUrl: "https://serper.dev",
  // 검색 횟수를 코드로 완전히 통제한다 — 이 경로를 만든 이유 중 하나다.
  supportsSearchLimit: true,

  // 토큰 단가는 모델 쪽(anthropic.ts)에서 조회되고, 검색 요금은 searchCostUsd로 직접 보고한다.
  pricing: {},

  async search({ refined, angle, model, maxSearches }, reportUsage): Promise<AngleFindings> {
    const apiKey = requireEnv(serperProvider);
    const client = anthropicClient();
    const searchErrors: string[] = [];

    // 1) 검색어는 refine 단계에서 이미 확정돼 캐시된다. 여기서 새로 만들지 않는 이유는 재현성이다 —
    //    매 실행마다 검색어를 새로 뽑으면 같은 아이디어가 매번 다른 리포트를 낸다.
    const queries = angle.queries.slice(0, maxSearches);
    if (queries.length === 0) {
      return { angle, text: "", sources: [], searchErrors: ["no_queries"], provider: "serper", queries: [] };
    }

    // 2) 병렬 검색. 실패한 검색어는 버리고 나머지로 진행한다 — 하나 때문에 각도를 통째로 잃지 않는다.
    const settled = await Promise.allSettled(queries.map((q: string) => serperSearch(apiKey, q)));
    const results: { query: string; hits: SerperHit[] }[] = [];
    settled.forEach((r: PromiseSettledResult<SerperHit[]>, i: number) => {
      if (r.status === "fulfilled") results.push({ query: queries[i]!, hits: r.value });
      else searchErrors.push(`query_failed: ${queries[i]} (${r.reason})`);
    });

    const executed = results.length;
    const queryLog = results.map((r) => ({ query: r.query, hits: r.hits.length }));
    if (executed === 0) {
      return { angle, text: "", sources: [], searchErrors, provider: "serper", queries: queryLog };
    }

    // 3) 스니펫만 넘겨 리서치 노트를 쓰게 한다. 페이지 본문은 컨텍스트에 들어가지 않는다.
    const stream = client.beta.messages.stream({
      model,
      max_tokens: 16000,
      ...requestOptionsFor(model, 16000),
      system: SEARCH_FROM_RESULTS_SYSTEM,
      messages: [{ role: "user", content: searchFromResultsUser(refined, angle, results) }],
    });

    const msg = await stream.finalMessage();
    assertNotRefused(msg, `search:serper:${angle.kind}:note`);
    reportUsage({
      ...(fromAnthropic(msg.usage) as Usage),
      webSearches: executed,
      searchCostUsd: executed * SERPER_PER_QUERY,
    });

    const text = msg.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (!text.trim()) searchErrors.push("empty_text");

    // 중복 URL은 하나로 접는다 — 검색어가 겹치면 같은 페이지가 여러 번 나온다.
    const seen = new Map<string, string>();
    for (const { hits } of results) {
      for (const h of hits) if (!seen.has(h.url)) seen.set(h.url, h.title);
    }

    return {
      angle,
      text,
      sources: [...seen].map(([url, title]) => ({ title, url })),
      searchErrors,
      provider: "serper",
      queries: queryLog,
    };
  },
};
