import { track, type Spend } from "../cost.js";
import { getProvider } from "../providers/registry.js";
import type { AngleFindings, Angle } from "../providers/types.js";
import type { RefinedIdea } from "../types.js";

/**
 * 검색 단계는 프로바이더에 위임한다. 여기서 하는 일은 사용량을 spend에 꽂는 것뿐이고,
 * 어느 프로바이더인지는 registry가 이름으로 찾아준다 — 이 파일에 프로바이더별 분기가 없다.
 */
export async function searchAngle(
  refined: RefinedIdea,
  angle: Angle,
  spend: Spend,
  opts: { provider: string; model: string; maxSearches: number },
): Promise<AngleFindings> {
  const provider = getProvider(opts.provider);

  return provider.search({ refined, angle, model: opts.model, maxSearches: opts.maxSearches }, (usage) =>
    track(spend, "search", opts.model, usage),
  );
}
