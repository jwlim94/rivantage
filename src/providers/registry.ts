import { anthropicProvider } from "./anthropic.js";
import { grokProvider } from "./grok.js";
import { serperProvider } from "./serper.js";
import type { ModelPricing, SearchProvider } from "./types.js";

/**
 * 등록된 검색 프로바이더.
 *
 * 새 프로바이더를 붙이는 방법:
 *   1. providers/<이름>.ts 를 만들어 SearchProvider 타입을 만족하는 객체를 export 한다
 *   2. 아래 배열에 추가한다
 *   3. .env.example 에 필요한 키를 적는다
 * 그 외 파일은 건드릴 필요가 없다 — CLI 플래그, 단가 계산, 기본 모델이 전부 여기서 파생된다.
 */
const REGISTRY: SearchProvider[] = [anthropicProvider, grokProvider, serperProvider];

export const DEFAULT_PROVIDER = anthropicProvider.name;

export function providerNames(): string[] {
  return REGISTRY.map((p) => p.name);
}

export function getProvider(name: string): SearchProvider {
  const hit = REGISTRY.find((p) => p.name === name);
  if (!hit) {
    console.error(`\n✗ --search-provider=${name} : 등록되지 않은 프로바이더`);
    console.error(`  사용 가능: ${providerNames().join(", ")}\n`);
    process.exit(1);
  }
  return hit;
}

/** 모델 ID로 단가를 찾는다. 어느 프로바이더가 서빙하든 상관없이 조회된다. */
export function pricingFor(model: string): ModelPricing {
  for (const provider of REGISTRY) {
    const price = provider.pricing[model];
    if (price) return price;
  }
  const known = REGISTRY.flatMap((p) => Object.keys(p.pricing));
  throw new Error(
    `단가 미등록 모델: ${model}\n  등록된 모델: ${known.join(", ")}\n  해당 프로바이더 파일의 pricing에 추가하세요.`,
  );
}
