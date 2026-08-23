import Anthropic from "@anthropic-ai/sdk";
import { SEARCH_SYSTEM, anglePrompt } from "../prompts.js";
import type { AngleFindings, SearchProvider, Usage } from "./types.js";

// ─────────────────────────────── 클라이언트 (구조화 출력 단계들도 이걸 쓴다)

/**
 * 구조화 출력 단계(refine/extract/consolidate)의 기본 모델.
 * 이 단계들은 아직 Anthropic 전용이다 — 프로바이더별 구조화 출력 방식이 달라서,
 * 두 번째 구현이 실제로 필요해지기 전까지는 추상화하지 않는다.
 */
export const DEFAULT_MODEL = "claude-opus-5";

/** Opus 5 이후 안전망. 리서치 태스크라 거부될 일은 거의 없지만 켜두는 비용이 0이다. */
export const BETAS = ["server-side-fallback-2026-07-01"] as const;

/** .env.example이 그대로 복사된 상태를 실제 키로 착각하지 않게 걸러낸다. */
const PLACEHOLDER = "sk-ant-REPLACE_ME";

let cached: Anthropic | null = null;

/**
 * 지연 생성 — 프로바이더를 Grok으로 골라도 refine/extract/consolidate가 Anthropic을 쓰므로
 * 결국 필요하지만, 키 검사 시점을 실제 사용 시점으로 미뤄 에러 메시지를 정확하게 만든다.
 */
export function anthropicClient(): Anthropic {
  if (cached) return cached;

  const key = process.env.ANTHROPIC_API_KEY?.trim();
  const token = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
  if (!token && (!key || key === PLACEHOLDER)) {
    const reason =
      key === PLACEHOLDER
        ? ".env의 ANTHROPIC_API_KEY가 아직 플레이스홀더입니다."
        : "ANTHROPIC_API_KEY가 설정되지 않았습니다.";
    console.error(
      [
        `\n✗ ${reason}`,
        "",
        "  1) cp .env.example .env",
        "  2) .env를 열어 ANTHROPIC_API_KEY에 실제 키를 넣으세요",
        "     키 발급: https://console.anthropic.com/settings/keys",
        "",
        "  (.env 대신 셸에서 export ANTHROPIC_API_KEY=... 해도 됩니다)\n",
      ].join("\n"),
    );
    process.exit(1);
  }

  // 자격증명은 환경에서 해석된다 — .env, 셸 export, 또는 ANTHROPIC_AUTH_TOKEN.
  cached = new Anthropic();
  return cached;
}

/**
 * 모델에 맞는 thinking 파라미터를 고른다.
 * 4.6 이후 모델은 adaptive를 쓰고, Haiku 4.5 같은 이전 세대는 budget_tokens를 요구한다.
 * (이전 세대에 adaptive를 보내거나 4.6+에 budget_tokens를 보내면 400이 난다.)
 */
/**
 * adaptive thinking을 받는가. 4.6 이후 세대만 받고, 이전 세대는 budget_tokens 방식을 쓴다.
 */
function supportsAdaptiveThinking(model: string): boolean {
  return !(/-(4-5|3-7|3-5)$/.test(model) || /haiku-4-5|sonnet-4-5|opus-4-5/.test(model));
}

/**
 * 거부 시 자동 폴백(fallbacks)을 받는가.
 * thinking 지원 여부와는 별개의 축이다 — Sonnet 5는 adaptive thinking은 받지만 fallbacks는 거부한다.
 * Opus 5 / Fable 5 계열에만 있다.
 */
function supportsFallbacks(model: string): boolean {
  return /opus-5|fable-5|mythos-5/.test(model);
}

/**
 * 모델 세대에 맞는 요청 옵션을 만든다. 호출부는 이걸 펼쳐 넣기만 하면 된다.
 *
 * 세대별 차이가 여러 개라 한 곳에 모아둔다:
 * 두 축이 서로 독립이다:
 * - adaptive thinking : 4.6 이후 세대 (Sonnet 5 포함)
 * - fallbacks        : Opus 5 / Fable 5 계열만 (Sonnet 5는 400을 낸다)
 */
export function requestOptionsFor(model: string, maxTokens: number) {
  // budget_tokens는 max_tokens보다 작아야 하고 최소 1024다. 둘이 같으면 400이 난다.
  const budget = Math.min(4000, Math.max(1024, Math.floor(maxTokens / 2)));
  const thinking = supportsAdaptiveThinking(model)
    ? ({ type: "adaptive" } as const)
    : ({ type: "enabled", budget_tokens: budget } as const);

  if (!supportsFallbacks(model)) return { thinking };
  return { thinking, betas: [...BETAS], fallbacks: "default" as const };
}

/** stop_reason이 refusal이면 content를 읽기 전에 터뜨린다. */
export function assertNotRefused(msg: Anthropic.Beta.BetaMessage, where: string): void {
  if (msg.stop_reason === "refusal") {
    const details = msg.stop_details;
    const category = details && "category" in details ? details.category : "unknown";
    throw new Error(`[${where}] 모델이 요청을 거부함 (category=${category})`);
  }
}

export function fromAnthropic(u: Anthropic.Beta.BetaUsage | undefined): Usage | undefined {
  if (!u) return undefined;
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    webSearches: u.server_tool_use?.web_search_requests ?? 0,
  };
}

// ─────────────────────────────── SearchProvider 구현

export const anthropicProvider: SearchProvider = {
  name: "anthropic",
  defaultSearchModel: DEFAULT_MODEL,
  requiredEnv: "ANTHROPIC_API_KEY",
  consoleUrl: "https://console.anthropic.com/settings/keys",
  supportsSearchLimit: true,

  /** 캐시 단가는 표준 배수(write 1.25x, read 0.1x) 기준 추정치. */
  pricing: {
    "claude-opus-5": { input: 5, output: 25, searchPer1k: 10 },
    "claude-sonnet-5": { input: 3, output: 15, searchPer1k: 10 },
    "claude-haiku-4-5": { input: 1, output: 5, searchPer1k: 10 },
  },

  async search({ refined, angle, model, maxSearches }, reportUsage): Promise<AngleFindings> {
    const client = anthropicClient();
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      { role: "user", content: anglePrompt(refined, angle) },
    ];
    const sources: AngleFindings["sources"] = [];
    const searchErrors: string[] = [];
    let text = "";

    // pause_turn: 서버 툴이 오래 걸리면 턴이 끊긴다. 응답을 돌려주고 이어서 진행한다.
    for (let turn = 0; turn < 6; turn++) {
      const stream = client.beta.messages.stream({
        model,
        max_tokens: 32000,
        ...requestOptionsFor(model, 32000),
        system: SEARCH_SYSTEM,
        messages,
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: maxSearches }],
      });

      const msg = await stream.finalMessage();
      assertNotRefused(msg, `search:${angle.kind}`);
      const usage = fromAnthropic(msg.usage);
      if (usage) reportUsage(usage);

      for (const block of msg.content) {
        if (block.type === "text") {
          text += block.text;
        } else if (block.type === "web_search_tool_result") {
          // 성공이면 content가 배열, 에러면 단일 객체다. 인덱싱 전에 분기해야 한다.
          if (Array.isArray(block.content)) {
            for (const r of block.content) sources.push({ title: r.title, url: r.url });
          } else {
            searchErrors.push(block.content.error_code);
          }
        }
      }

      if (msg.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: msg.content });
    }

    return { angle, text, sources, searchErrors, provider: "anthropic" };
  },
};
