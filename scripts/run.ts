import fs from "node:fs";
import path from "node:path";
import { STAGES, formatSpendTable, newSpend, totalCost, type Spend, type Stage } from "../lib/pipeline/cost.js";
import { DEFAULT_PROVIDER, getProvider, providerNames } from "../lib/pipeline/providers/registry.js";
import { refineIdea } from "../lib/pipeline/steps/refine.js";
import { searchAngle } from "../lib/pipeline/steps/search.js";
import { extractCandidates } from "../lib/pipeline/steps/extract.js";
import { consolidate, poolCandidates } from "../lib/pipeline/steps/consolidate.js";
import { analyzeReviews, pickReviewTargets } from "../lib/pipeline/steps/reviews.js";
import { mapPositioning, pickPositioningTargets, renderAxis } from "../lib/pipeline/steps/positioning.js";
import { makeCache } from "../lib/pipeline/cache.js";
import { Consolidated, ExtractedCandidates, PositioningMap, RefinedIdea } from "../lib/pipeline/types.js";
import type { SearchProvider } from "../lib/pipeline/providers/types.js";

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
  // 리뷰는 "주어진 글에서 사용자 목소리를 골라내는" 작업이라 extract와 성격이 같다.
  reviews: "claude-haiku-4-5",
  // 포지셔닝은 축을 찾아내는 판단이라 consolidate와 성격이 같다.
  positioning: "claude-opus-5",
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
    reviews: argv.includes("--reviews") || argv.includes("--full"),
    reviewTop: num("review-top", 12),
    positioning: argv.includes("--positioning") || argv.includes("--full"),
    positionTop: num("position-top", 25),
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
  /** 5단계(리뷰 기반 강약점)를 돌릴지. 기본은 끔 — 경쟁사 식별만 빠르게 보고 싶을 때가 많다. */
  reviews: boolean;
  /** 리뷰를 분석할 경쟁사 수 상한. 비용이 여기에 비례한다. */
  reviewTop: number;
  /** 6단계(차별점 매핑)를 돌릴지. --full이면 리뷰와 함께 켜진다. */
  positioning: boolean;
  positionTop: number;
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
  const { reviews, reviewTop, positioning, positionTop, onlyAngle, maxSearches, anglesPerKind, noCache, models, provider, refresh } =
    opts;
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
    : await cached(
        `consolidate-${provider.name}`,
        () => {
          console.log(`\n[4/4] 후보 ${rawCount}개 → 도메인 중복 제거 후 ${pooled.length}개 → 정리 중...`);
          return consolidate(refined, pooled, spend, { model: models.consolidate });
        },
        (v) => Consolidated.safeParse(v).data ?? null,
      );

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
  // ── 5단계: 리뷰 기반 강약점 (--reviews)
  let reviewResults: Awaited<ReturnType<typeof analyzeReviews>> = [];
  if (reviews && result.competitors.length) {
    const targets = pickReviewTargets(result.competitors, reviewTop);
    console.log(`\n[5/5] 리뷰 분석 — 대상 ${targets.length}개 (direct 우선, traction=none 제외)...`);
    reviewResults = await cached(
      `reviews-${provider.name}-${reviewTop}`,
      () =>
        analyzeReviews(targets, spend, {
          model: models.reviews,
          // 동명이인을 피하려면 도메인 맥락이 필요하다. refine이 뽑은 카테고리명을 쓴다.
          category: refined.category_labels[0] ?? "",
          onProgress: (r) => {
            const n = r.strengths.length + r.weaknesses.length;
            console.log(
              `  · ${r.competitor.slice(0, 38).padEnd(38)} ${r.sentiment.padEnd(16)} 근거 ${r.evidence_count}건 → ${n}개 항목`,
            );
          },
        }),
      (v) => (Array.isArray(v) ? (v as typeof reviewResults) : null),
    );

    const useful = reviewResults.filter((r) => r.sentiment !== "insufficient");
    console.log(`\n── 리뷰 강약점 (근거 있는 ${useful.length}/${reviewResults.length}개) ──`);
    for (const r of useful) {
      console.log(`\n  ▌${r.competitor}  [${r.sentiment}]`);
      // 출처 URL을 같이 찍는다 — 근거를 직접 확인할 수 있어야 "판단은 유저 몫"이 성립한다.
      const point = (mark: string, p: { point: string; quote: string; source_url: string }) => {
        console.log(`    ${mark} ${p.point}`);
        console.log(`        "${p.quote.slice(0, 100)}"`);
        console.log(`        ← ${p.source_url}`);
      };
      for (const s of r.strengths) point("+", s);
      for (const w of r.weaknesses) point("−", w);
      if (r.note) console.log(`      ${r.note}`);
    }
    const none = reviewResults.filter((r) => r.sentiment === "insufficient");
    if (none.length) {
      console.log(`\n  근거 못 찾음 ${none.length}개: ${none.map((r) => r.competitor).join(", ")}`);
    }
  }

  // ── 6단계: 차별점 매핑 (--positioning)
  let posMap: Awaited<ReturnType<typeof mapPositioning>> | null = null;
  if (positioning && result.competitors.length) {
    const targets = pickPositioningTargets(result.competitors, positionTop);
    console.log(`\n[6/6] 차별점 매핑 — 대상 ${targets.length}개...`);
    posMap = await cached(
      `positioning-${provider.name}-${positionTop}`,
      () => mapPositioning(refined, targets, reviewResults, spend, { model: models.positioning }),
      (v) => PositioningMap.safeParse(v).data ?? null,
    );

    console.log(`\n── 이 시장이 갈리는 축 ──`);
    for (const a of posMap.axes) {
      console.log(`\n  ▌${a.name}:  ${a.low_label}  ←→  ${a.high_label}`);
      console.log(`      ${a.why}`);
    }

    console.log(`\n── 경쟁사 배치 ──`);
    const head = posMap.axes.map((a) => a.name.slice(0, 12).padEnd(13)).join(" ");
    console.log(`  ${"".padEnd(30)} ${head}`);
    for (const p of posMap.placements) {
      const cells = posMap.axes
        .map((a) => {
          const hit = p.positions.find((x) => x.axis === a.name);
          return renderAxis(hit?.position ?? "unknown").padEnd(13);
        })
        .join(" ");
      console.log(`  ${p.competitor.slice(0, 29).padEnd(30)} ${cells}`);
    }

    if (posMap.gaps.length) {
      console.log(`\n── 비어 보이는 자리 ──`);
      for (const g of posMap.gaps) console.log(`  · ${g.where}\n      ${g.assessment}`);
    }
    console.log(`\n── 경쟁사들이 실제로 겨루는 지점 ──\n  ${posMap.contested}`);
    console.log(`\n── 입력한 아이디어의 자리 ──`);
    console.log(`  ${posMap.your_position.summary}`);
    console.log(`  가장 가까운 곳: ${posMap.your_position.nearest.join(", ") || "없음"}`);
    console.log(`  ⚠ ${posMap.your_position.caveat}`);
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
        reviews: reviewResults,
        positioning: posMap,
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
  const opts = parseArgs(process.argv.slice(2));
  const { rest, fixtureFlag, all } = opts;
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
        "  --reviews               5단계: 리뷰 기반 강약점까지 (약 $0.15 추가)",
        "  --review-top=12         리뷰를 분석할 경쟁사 수 상한",
        "  --positioning           6단계: 차별점 매핑 (약 $0.1 추가)",
        "  --full                  5·6단계를 모두 실행",
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
    summaries.push(await runOne(job.id, job.idea, opts));
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
