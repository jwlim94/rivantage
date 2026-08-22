import fs from "node:fs";
import path from "node:path";
import { STAGES, formatSpendTable, newSpend, totalCost, type Spend, type Stage } from "./cost.js";
import { DEFAULT_PROVIDER, getProvider, providerNames } from "./providers/registry.js";
import { refineIdea } from "./steps/refine.js";
import { searchAngle } from "./steps/search.js";
import { extractCandidates } from "./steps/extract.js";
import { consolidate, poolCandidates } from "./steps/consolidate.js";
import { makeCache } from "./cache.js";
import { ExtractedCandidates, RefinedIdea } from "./types.js";
import type { SearchProvider } from "./providers/types.js";

/**
 * 단계별 기본 모델. 실측으로 고른 조합이다:
 * - refine      : 검색어를 여기서 확정하므로 품질이 파이프라인 전체를 좌우한다 → 가장 좋은 모델
 * - extract     : 노트를 레코드로 옮기는 기계적 작업 → 싼 모델로 충분 (실측상 판정 차이 없음)
 * - consolidate : traction 판정과 커버리지 공백 지적에 회의적 판단이 필요 → 좋은 모델
 *                 (Haiku로 내리면 "홈페이지가 있다"를 실사용 흔적으로 치는 과잉 판정이 나온다)
 * search는 프로바이더가 자기 기본 모델을 정한다.
 */
const STAGE_DEFAULT_MODELS: Record<Stage, string> = {
  refine: "claude-opus-5",
  search: "",
  extract: "claude-haiku-4-5",
  consolidate: "claude-opus-5",
};

/** 진행 중인 실행의 사용량. 크래시 핸들러가 읽는다. */
let activeSpend: Spend | null = null;

type Fixture = { id: string; note: string; idea: string };

function loadFixtures(): Fixture[] {
  return JSON.parse(fs.readFileSync("fixtures/ideas.json", "utf8"));
}

function parseArgs(argv: string[]) {
  const num = (flag: string, fallback: number) =>
    Number(argv.find((a) => a.startsWith(`--${flag}=`))?.split("=")[1] ?? fallback);
  const rest = argv.filter((a) => !a.startsWith("--"));
  const str = (flag: string) => argv.find((a) => a.startsWith(`--${flag}=`))?.split("=")[1];

  // 우선순위: --<단계>-model > --model > 단계별 기본값 > (search는) 프로바이더 기본값
  const baseModel = str("model");
  const models = Object.fromEntries(
    STAGES.map((st) => [st, str(`${st}-model`) ?? baseModel ?? STAGE_DEFAULT_MODELS[st]]),
  ) as Record<Stage, string>;

  // 등록되지 않은 이름이면 registry가 사용 가능한 목록을 띄우고 종료한다.
  const provider = getProvider(str("search-provider") ?? DEFAULT_PROVIDER);
  if (!str("search-model") && !baseModel) models.search = provider.defaultSearchModel;

  const refresh = new Set((str("refresh") ?? "").split(",").filter(Boolean));
  for (const st of refresh) {
    if (!STAGES.includes(st as Stage)) {
      console.error(`--refresh=${st} : 알 수 없는 단계. 가능: ${STAGES.join(", ")}`);
      process.exit(1);
    }
  }

  return {
    onlyAngle: str("angle"),
    maxSearches: num("searches", 8),
    anglesPerKind: num("angles", 1),
    noCache: argv.includes("--no-cache"),
    models,
    provider,
    refresh,
    rest,
    fixtureFlag: argv.includes("--fixture"),
    all: argv.includes("--all"),
  };
}

type RunOpts = {
  /** 지정하면 그 kind의 각도 하나만 실행한다. 비용을 재보려고 붙인 플래그다. */
  onlyAngle?: string;
  maxSearches: number;
  anglesPerKind: number;
  noCache: boolean;
  models: Record<Stage, string>;
  provider: SearchProvider;
  refresh: Set<string>;
};

async function runOne(id: string, idea: string, opts: RunOpts) {
  const { onlyAngle, maxSearches, anglesPerKind, noCache, models, provider, refresh } = opts;
  const spend = newSpend();
  // 크래시해도 여기까지 쓴 비용을 보고한다 — 응답을 받은 시점에 이미 과금됐기 때문이다.
  activeSpend = spend;
  const startedAt = Date.now();
  const hits: string[] = [];
  const cached = makeCache(id, { enabled: !noCache, refresh }, (key) => hits.push(key));
  console.log(`\n${"=".repeat(70)}\n▶ ${id}\n${"=".repeat(70)}`);

  console.log("[1/4] 아이디어 정제 중...");
  const refined = await cached(
    "refine",
    () => refineIdea(idea, spend, { anglesPerKind, queriesPerAngle: maxSearches, model: models.refine }),
    (v) => RefinedIdea.safeParse(v).data ?? null,
  );
  console.log(`  카테고리: ${refined.category_labels.join(" / ")}`);
  console.log(`  검색 각도 ${refined.angles.length}개:`);
  for (const a of refined.angles)
    console.log(`    · [${a.kind}] 검색어 ${a.queries.length}개 — ${a.queries[0]}`);

  // --angle=<kind> 로 한 각도만 돌릴 수 있다. 인덱스는 원본 기준을 유지해야 캐시 키가 어긋나지 않는다.
  const selected = refined.angles
    .map((angle, index) => ({ angle, index }))
    .filter(({ angle }) => !onlyAngle || angle.kind === onlyAngle);

  if (onlyAngle && selected.length === 0) {
    console.error(`\n✗ --angle=${onlyAngle} : 이 아이디어에 그 kind의 각도가 없다.`);
    console.error(`  가능: ${[...new Set(refined.angles.map((a) => a.kind))].join(", ")}\n`);
    process.exit(1);
  }
  if (onlyAngle) {
    console.log(`\n  ※ --angle=${onlyAngle} → ${selected.length}개 각도만 실행 (비용 측정용 부분 실행)`);
  }

  const limitNote = provider.supportsSearchLimit
    ? `각도당 최대 ${maxSearches}회`
    : "검색 횟수 상한 없음 (이 프로바이더는 제어 불가)";
  console.log(
    `\n[2/4] 각도별 웹서치 (${provider.name} / ${models.search}, ${limitNote}) + [3/4] 후보 추출 (병렬)...`,
  );
  const perAngle = await Promise.all(
    selected.map(async ({ angle, index: i }) => {
      // 기본 프로바이더는 접미사 없는 키를 쓴다 — 이미 받아둔 검색 결과를 버리지 않기 위해서다.
      const tag = provider.name === DEFAULT_PROVIDER ? "" : `${provider.name}-`;
      const slot = `${tag}${i}-${angle.kind}`;
      const findings = await cached(`search-${slot}`, () =>
        searchAngle(refined, angle, spend, {
          provider: provider.name,
          model: models.search,
          maxSearches,
        }),
      );
      if (findings.searchErrors.length) {
        console.log(`  ! [${angle.kind}] 검색 에러: ${findings.searchErrors.join(", ")}`);
      }
      const extracted = await cached(
        `extract-${slot}`,
        () => extractCandidates(findings, spend, { model: models.extract }),
        (v) => ExtractedCandidates.safeParse(v).data ?? null,
      );
      const qn = findings.queries?.length;
      const thin = findings.sources.length < 20 ? "  ⚠ 소스 빈약" : "";
      console.log(
        `  · [${angle.kind}] 검색어 ${qn ?? "?"}개 → 소스 ${findings.sources.length}개 → 후보 ${extracted.candidates.length}개${thin}`,
      );
      return { kind: angle.kind, findings, extracted };
    }),
  );

  const pooled = poolCandidates(
    perAngle.map((p) => ({ kind: p.kind, candidates: p.extracted.candidates })),
  );
  const rawCount = perAngle.reduce((n, p) => n + p.extracted.candidates.length, 0);

  // 부분 실행에서는 정리 단계를 건너뛴다. 한 각도 결과만으로 경쟁 지형을 정리하는 건 의미가 없고,
  // 이 모드의 목적은 search 비용을 재는 것이다.
  const result = onlyAngle
    ? { competitors: [], excluded: [], coverage_gaps: [] }
    : await (async () => {
        console.log(`\n[4/4] 후보 ${rawCount}개 → 도메인 중복 제거 후 ${pooled.length}개 → 정리 중...`);
        return consolidate(refined, pooled, spend, { model: models.consolidate });
      })();

  if (onlyAngle) {
    console.log(`\n[4/4] 건너뜀 (부분 실행) — 후보 ${rawCount}개, 중복 제거 후 ${pooled.length}개`);
    console.log(`\n── 이 각도에서 나온 후보 ──`);
    for (const { candidate: c, angles } of pooled) {
      console.log(`  [${c.relation}/${c.size_hint}/${c.confidence}] ${c.name} — ${c.url}`);
      console.log(`      ${c.one_liner}`);
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
  // 실사용 흔적으로 티어를 나눈다. 걸러내는 게 아니라 창업자가 무게를 다르게 보라고 나누는 것이다.
  const TIERS = [
    { key: "confirmed", label: "확인된 경쟁사 — 리뷰·가격·커뮤니티 흔적 있음" },
    { key: "weak", label: "초기 단계 — 제품은 있으나 실사용 흔적 미확인" },
    { key: "none", label: "실체 미확인 — 이름만 등장" },
  ] as const;

  console.log(`\n── 경쟁사 ${result.competitors.length}개 ──`);
  for (const tier of TIERS) {
    const group = result.competitors.filter((c) => c.traction === tier.key);
    if (!group.length) continue;
    console.log(`\n  ▌${tier.label} (${group.length}개)`);
    for (const c of group) {
      const reviews = c.review_sources.length ? ` · 리뷰: ${c.review_sources.join(", ")}` : "";
      console.log(`    [${c.relation}/${c.size_hint}] ${c.name} — ${c.url}${reviews}`);
      console.log(`        ${c.one_liner}`);
      console.log(`        겹침: ${c.why_competitor}`);
      console.log(`        흔적: ${c.traction_evidence}`);
    }
  }
  if (result.excluded.length) {
    console.log(`\n── 제외 ${result.excluded.length}개 ──`);
    for (const e of result.excluded) console.log(`  · ${e.name}: ${e.reason}`);
  }
  if (result.coverage_gaps.length) {
    console.log(`\n── 커버리지 공백 ──`);
    for (const g of result.coverage_gaps) console.log(`  · ${g}`);
  }
  console.log(formatSpendTable(spend));
  const cacheNote = hits.length ? `  · 캐시 히트 ${hits.length}건 (해당 단계 비용은 위 표에서 빠져 있다)` : "";
  console.log(`  ${elapsed}s 소요${cacheNote ? "\n" + cacheNote : ""}`);

  // 파일명에 프로바이더와 부분 실행 여부를 담아 서로 덮어쓰지 않게 한다.
  // 기본 프로바이더의 전체 실행만 접미사 없는 이름을 쓴다(기존 결과와 호환).
  const suffix = [
    provider.name === DEFAULT_PROVIDER ? "" : provider.name,
    onlyAngle ? `only-${onlyAngle}` : "",
  ]
    .filter(Boolean)
    .join(".");
  const outPath = path.join("out", suffix ? `${id}.${suffix}.json` : `${id}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        id,
        idea,
        refined,
        angles: perAngle.map((p) => ({
          kind: p.kind,
          plannedQueries: p.findings.angle.queries,
          executedQueries: p.findings.queries,
          sources: p.findings.sources,
          searchErrors: p.findings.searchErrors,
          notes: p.extracted.notes,
          candidates: p.extracted.candidates,
          rawText: p.findings.text,
        })),
        result,
        spend,
        elapsedSeconds: Number(elapsed),
      },
      null,
      2,
    ),
  );
  console.log(`→ ${outPath}`);
  return {
    id,
    competitors: result.competitors.length,
    spend,
    cost: totalCost(spend),
    elapsed: Number(elapsed),
  };
}

async function main() {
  const { onlyAngle, maxSearches, anglesPerKind, noCache, models, provider, refresh, rest, fixtureFlag, all } =
    parseArgs(process.argv.slice(2));
  const fixtures = loadFixtures();

  let jobs: { id: string; idea: string }[];
  if (all) {
    jobs = fixtures;
  } else if (fixtureFlag) {
    const wanted = rest[0];
    const f = fixtures.find((x) => x.id === wanted);
    if (!f) {
      console.error(`fixture '${wanted}' 없음. 사용 가능: ${fixtures.map((x) => x.id).join(", ")}`);
      process.exit(1);
    }
    jobs = [f];
  } else if (rest.length) {
    jobs = [{ id: "adhoc", idea: rest.join(" ") }];
  } else {
    console.error(
      [
        "사용법:",
        '  npm run dev -- "아이디어 텍스트"        직접 입력',
        "  npm run dev -- --fixture niche-hvac     저장된 아이디어 하나",
        "  npm run dev -- --all                    전부 (순차 실행)",
        "",
        "  --angles=1              검색 각도 kind당 개수 (총 4종 × N). 기본 1",
        "  --angle=direct_category 한 kind만 실행 (비용을 먼저 재볼 때)",
        "  --searches=8            각도당 최대 웹서치 횟수 (지원하는 프로바이더에서만)",
        "  --no-cache              cache/<id>를 무시하고 전부 다시 실행",
        "  --refresh=extract,...   특정 단계만 캐시 무효화 (refine/search/extract/consolidate)",
        `  --search-provider=X     검색 프로바이더. 등록됨: ${providerNames().join(", ")} (기본 ${DEFAULT_PROVIDER})`,
        "  --model=X               전 단계 모델을 한 번에 지정 (단계별 기본값을 덮어씀)",
        "  --extract-model=X       단계별 오버라이드 (refine/search/extract/consolidate-model)",
        "",
        `  단계별 기본: refine=${STAGE_DEFAULT_MODELS.refine} extract=${STAGE_DEFAULT_MODELS.extract} consolidate=${STAGE_DEFAULT_MODELS.consolidate}`,
        "",
        `저장된 아이디어: ${fixtures.map((x) => x.id).join(", ")}`,
      ].join("\n"),
    );
    process.exit(1);
  }

  const summaries = [];
  for (const job of jobs) {
    summaries.push(await runOne(job.id, job.idea, { onlyAngle, maxSearches, anglesPerKind, noCache, models, provider, refresh }));
  }

  if (summaries.length > 1) {
    console.log(`\n${"=".repeat(70)}\n전체 요약`);
    for (const s of summaries) {
      console.log(`  ${s.id}: 경쟁사 ${s.competitors}개  ${s.elapsed}s  $${s.cost.toFixed(3)}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  if (activeSpend && STAGES.some((st) => activeSpend![st].calls > 0)) {
    console.error("\n  ⚠ 중단됐지만 아래 호출은 이미 과금됐다 (응답을 받은 시점에 청구된다):");
    console.error(formatSpendTable(activeSpend));
  }
  process.exit(1);
});
