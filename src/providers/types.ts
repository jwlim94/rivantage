import type { z } from "zod";
import type { RefinedIdea, SearchAngle } from "../types.js";

export type Angle = z.infer<typeof SearchAngle>;

/** 두 프로바이더가 동일하게 반환해야 하는 검색 산출물. 3·4단계는 어느 쪽이 왔는지 몰라도 된다. */
export type AngleFindings = {
  angle: Angle;
  /** 모델이 검색 결과를 읽고 정리한 산문. 다음 단계에서 구조화한다. */
  text: string;
  /** 실제로 열어본 검색 결과 URL. 후보의 실존 여부를 사람이 직접 검증할 때 쓴다. */
  sources: { title: string; url: string }[];
  searchErrors: string[];
  provider: string;
  /**
   * 실제로 실행한 검색어와 각각이 돌려준 결과 수.
   * 어떤 각도가 왜 빈손이었는지(쿼리를 적게 만들었나 / 겹쳤나 / 빗나갔나) 사후에 알려면 필요하다.
   */
  queries?: { query: string; hits: number }[];
};

/** 프로바이더 중립 usage. 각 구현이 자기 응답을 이 모양으로 변환해서 보고한다. */
export type Usage = {
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
  webSearches?: number;
  /**
   * 검색 툴 요금을 프로바이더가 직접 계산했으면 여기 담는다.
   * 검색 제공자와 모델 제공자가 다른 조합(예: Serper 검색 + Claude 모델)에서 필요하다 —
   * 모델 단가표의 searchPer1k를 쓰면 엉뚱한 값이 나오기 때문이다.
   */
  searchCostUsd?: number;
  /**
   * 프로바이더가 응답에 실제 청구액을 실어주면 여기에 담는다.
   * 있으면 단가표 기반 추정 대신 이 값을 쓴다 — 캐시 할인이나 초과 요율이 이미 반영돼 있기 때문이다.
   */
  reportedCostUsd?: number;
};

/** $/1M 토큰, 웹서치는 $/1k회. */
export type ModelPricing = { input: number; output: number; searchPer1k: number };

export type SearchInput = {
  refined: RefinedIdea;
  angle: Angle;
  model: string;
  /** 검색 횟수 상한. supportsSearchLimit이 false인 프로바이더는 무시한다. */
  maxSearches: number;
};

/**
 * 프로바이더 하나가 지켜야 할 계약.
 * 새 프로바이더를 붙이려면 이 타입을 만족하는 객체 하나를 만들고 registry.ts에 등록하면 된다.
 */
export type SearchProvider = {
  /** CLI에서 --search-provider=<name> 으로 지정하는 이름 */
  name: string;
  /** 이 프로바이더를 고르면 search 단계 기본 모델이 이것으로 바뀐다 */
  defaultSearchModel: string;
  /** 이 환경변수가 없으면 실행 전에 막는다 */
  requiredEnv: string;
  /** 키 발급처 — 에러 메시지에 띄운다 */
  consoleUrl: string;
  /** 검색 횟수 상한을 걸 수 있는가. false면 --searches가 무시된다고 경고한다 */
  supportsSearchLimit: boolean;
  /** 이 프로바이더가 서빙하는 모델들의 단가 */
  pricing: Record<string, ModelPricing>;
  /** 사용량은 반환값이 아니라 콜백으로 보고한다 — 여러 턴을 도는 구현도 있기 때문이다 */
  search(input: SearchInput, reportUsage: (usage: Usage) => void): Promise<AngleFindings>;
};

/** 각 프로바이더가 키 검사에 공통으로 쓰는 헬퍼. */
export function requireEnv(provider: Pick<SearchProvider, "name" | "requiredEnv" | "consoleUrl">): string {
  const value = process.env[provider.requiredEnv]?.trim();
  if (value) return value;

  console.error(
    [
      `\n✗ ${provider.requiredEnv}가 없습니다. --search-provider=${provider.name} 은 이 키가 필요합니다.`,
      "",
      `  .env에 ${provider.requiredEnv}=... 를 추가하세요.`,
      `  키 발급: ${provider.consoleUrl}`,
      "",
      "  (다른 프로바이더로 바꾸려면 --search-provider=<이름>)\n",
    ].join("\n"),
  );
  process.exit(1);
}
