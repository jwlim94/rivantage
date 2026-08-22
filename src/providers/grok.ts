import OpenAI from "openai";
import { SEARCH_SYSTEM, anglePrompt } from "../prompts.js";
import { requireEnv, type AngleFindings, type SearchProvider } from "./types.js";

/**
 * Grok의 web_search는 Responses API(/v1/responses)에서만 쓸 수 있다.
 * 레거시 search_parameters 방식은 2026-01-12에 폐기되어 410을 반환한다.
 */
const BASE_URL = "https://api.x.ai/v1";

/** OpenAI SDK 타입에 없는 xAI 확장 필드. probe로 실제 응답에서 확인한 것들이다. */
type GrokUsage = {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  cost_in_usd_ticks?: number;
  server_side_tool_usage_details?: { web_search_calls?: number };
};

let cached: OpenAI | null = null;

function grokClient(): OpenAI {
  if (cached) return cached;
  const apiKey = requireEnv(grokProvider);
  // 추론 모델은 응답이 길어 기본 타임아웃으로는 모자란다.
  cached = new OpenAI({ apiKey, baseURL: BASE_URL, timeout: 600_000 });
  return cached;
}

/**
 * 소스는 output 배열의 web_search_call 아이템에 실린다:
 *   output[].action.sources[] = { type: "url", url: "..." }
 * 제목은 오지 않으므로, 그 소스를 끌어온 검색어를 대신 붙인다 — 어느 쿼리의 결과인지가 더 유용하다.
 */
function collectSources(output: unknown): { title: string; url: string }[] {
  const found = new Map<string, string>();
  if (!Array.isArray(output)) return [];

  for (const item of output as Record<string, unknown>[]) {
    if (item.type !== "web_search_call") continue;
    const action = item.action as Record<string, unknown> | undefined;
    const query = typeof action?.query === "string" ? action.query : "";
    const sources = Array.isArray(action?.sources) ? action.sources : [];
    for (const src of sources as Record<string, unknown>[]) {
      const url = src.url;
      if (typeof url !== "string" || !/^https?:\/\//.test(url)) continue;
      if (!found.has(url)) found.set(url, query ? `검색: ${query}` : "");
    }
  }

  return [...found].map(([url, title]) => ({ title, url }));
}

export const grokProvider: SearchProvider = {
  name: "grok",
  defaultSearchModel: "grok-4.6",
  requiredEnv: "XAI_API_KEY",
  consoleUrl: "https://console.x.ai",
  // xAI web_search 툴은 검색 횟수 상한 파라미터를 노출하지 않는다.
  supportsSearchLimit: false,

  /**
   * 주의: grok-4.6은 단일 요청이 200K 토큰을 넘으면 그 요청 전체가 2배 요율($4/$12)로 청구된다.
   * 아래 값은 200K 이하 기준이므로, 검색 결과가 쌓이면 실제 청구액이 계산보다 높아진다.
   */
  pricing: {
    "grok-4.6": { input: 2, output: 6, searchPer1k: 5 },
    "grok-4.5": { input: 2, output: 6, searchPer1k: 5 },
    "grok-4.3": { input: 1.25, output: 2.5, searchPer1k: 5 },
  },

  async search({ refined, angle, model }, reportUsage): Promise<AngleFindings> {
    const client = grokClient();
    const searchErrors: string[] = [];

    let res;
    try {
      res = await client.responses.create({
        model,
        instructions: SEARCH_SYSTEM,
        input: [{ role: "user", content: anglePrompt(refined, angle) }],
        tools: [{ type: "web_search" } as never],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`[search:grok:${angle.kind}] 요청 실패: ${message}`);
    }

    const usage = res.usage as unknown as GrokUsage | undefined;
    const webSearches = usage?.server_side_tool_usage_details?.web_search_calls ?? 0;

    // xAI는 실제 청구액을 응답에 실어준다. 단위는 문서화돼 있지 않지만,
    // 1 tick = 1e-10 USD 로 해석하면 단가표 계산(캐시 할인 포함)과 소수점 6자리까지 일치한다.
    const reportedCostUsd =
      typeof usage?.cost_in_usd_ticks === "number" ? usage.cost_in_usd_ticks / 1e10 : undefined;

    reportUsage({
      input: usage?.input_tokens ?? 0,
      output: usage?.output_tokens ?? 0,
      cacheRead: usage?.input_tokens_details?.cached_tokens ?? 0,
      webSearches,
      reportedCostUsd,
    });

    const text = res.output_text ?? "";
    if (!text.trim()) searchErrors.push("empty_output_text");

    return { angle, text, sources: collectSources(res.output), searchErrors, provider: "grok" };
  },
};
