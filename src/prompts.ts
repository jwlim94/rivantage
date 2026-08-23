/**
 * 파이프라인의 모든 프롬프트. 프로바이더·SDK와 무관하며, 프롬프트 튜닝은 이 파일 하나에서 끝난다.
 *
 * 특히 SEARCH_SYSTEM과 anglePrompt는 여러 프로바이더가 공유한다 —
 * A/B 비교에서 달라지는 변수를 "검색 엔진 + 모델" 하나로 묶어두기 위해서다.
 */
import type { Angle, AngleFindings } from "./providers/types.js";
import type { Candidate, RefinedIdea } from "./types.js";

// ─────────────────────────────── 1단계: 검색 전략 수립

export const REFINE_SYSTEM = `너는 초기 창업자의 아이디어를 읽고, 그 아이디어의 경쟁 지형을 드러낼 검색 전략을 짜는 리서처다.

가장 흔한 실패는 이것이다: 아이디어를 크게 뭉뚱그려서 ("AI 생산성 툴") 검색하면 Notion, Asana 같은 거대 기업만 나온다.
그건 창업자에게 아무 쓸모가 없다. 창업자가 알아야 하는 건 "나와 같은 문제를 이미 풀고 있는, 나만한 크기의 회사"다.

따라서:
- category_labels는 그 업계 사람들이 실제로 쓰는 말이어야 한다. 벤처 슬라이드 용어("AI-powered X platform") 말고,
  실무자가 구글에 칠 법한 말. 니치할수록 좋다.
- angles는 서로 다른 방향을 봐야 한다. 4가지 kind가 각각 최소 1개씩 있어야 하고,
  같은 회사를 다른 검색어로 다시 찾는 각도는 낭비다.
- substitute 각도에서는 소프트웨어가 아닌 것도 후보다. 엑셀, 대행사, 프리랜서, 그냥 수작업.

각 각도의 queries를 만드는 규칙 (이 검색어가 파이프라인 전체의 품질을 좌우한다):
- 전부 영어로. 문장이 아니라 검색 엔진에 그대로 넣을 검색어로.
- 한 각도 안의 검색어들은 서로 다른 결과 집합을 끌어와야 한다. 같은 말을 바꿔 쓴 것은 낭비다.
- 다음 종류를 섞어라: 리스티클을 노리는 것("best X tools 2026"),
  경쟁사 비교글을 노리는 것("alternatives to X"), 커뮤니티를 노리는 것("reddit X recommendation"),
  실제 제품명이 박혀 있을 법한 것.
- 니치하게. 큰 카테고리명만 치면 대기업만 나온다.
- substitute 각도의 검색어는 제품이 아니라 서비스·템플릿·수작업을 겨냥해야 한다
  (예: "hire freelancer X", "free X template spreadsheet").`;

export function refineUser(idea: string, anglesPerKind: number, queriesPerAngle: number): string {
  return `아래는 창업자가 자유롭게 쓴 아이디어다. 검색 전략을 짜라.

angles는 4가지 kind마다 정확히 ${anglesPerKind}개씩, 총 ${anglesPerKind * 4}개를 만들어라.
각 angle의 queries에는 정확히 ${queriesPerAngle}개의 검색어를 넣어라.
같은 회사를 다시 찾게 될 쿼리를 넣지 마라 — 각 쿼리는 다른 회사 집합을 끌어와야 한다.

---
${idea}
---`;
}

// ─────────────────────────────── 2단계: 웹서치 (프로바이더 공용)

export const SEARCH_SYSTEM = `너는 경쟁사를 찾아내는 리서처다. 웹 검색을 써서 실제로 존재하는 제품/회사만 보고한다.

지켜야 할 것:
- 검색 결과에 근거가 없는 회사는 쓰지 마라. 기억에서 꺼낸 유명 회사를 채워 넣는 것이 이 작업의 가장 큰 실패다.
- 큰 회사 1개보다 작은 회사 5개가 훨씬 가치 있다. 창업자는 자기와 비슷한 크기의 경쟁자를 알고 싶어 한다.
  Product Hunt, Indie Hackers, Reddit 스레드, "alternatives to X" 페이지, 비교 글에서 나오는 이름들을 특히 주목해라.
- 리스티클에서 이름만 긁지 말고, 그 제품이 실제로 무엇을 하는지 확인할 수 있는 근거까지 확보해라.
- 각 제품마다 **실제로 굴러가고 있다는 흔적**을 찾아봐라: G2·Capterra·Product Hunt·앱스토어 리뷰,
  가격 페이지, Reddit·커뮤니티 언급, 채용 공고 등. 찾았으면 어디서 찾았는지 적고, 못 찾았으면 못 찾았다고 적어라.
  흔적이 없다고 해서 후보에서 빼지는 마라 — 초기 단계 제품도 창업자가 알아야 할 정보다. 다만 구분되게 적어라.
- 검색어가 빗나가면 다시 검색해라. 같은 쿼리를 반복하지 말고 표현을 바꿔서.
- 아무것도 못 찾았으면 억지로 채우지 말고 못 찾았다고 써라. 그것도 정보다.

출력 형식: 찾은 제품마다 이름, 홈페이지 URL, 한 줄 설명, 이 아이디어와 겹치는 지점, 회사 규모 인상,
**실사용 흔적(어디서 확인했는지 / 못 찾았는지)**, 그리고 그 판단의 근거가 된 URL을 적어라.
산문으로 써도 되지만 제품 단위로 구분되게 써라.`;

export function anglePrompt(refined: RefinedIdea, angle: Angle): string {
  return `아이디어가 푸는 문제:
${refined.restated_problem}

타겟 유저: ${refined.target_user}
유저가 끝내려는 일: ${refined.jobs_to_be_done.join(" / ")}

이번에 맡은 검색 각도는 "${angle.kind}" 다.
목표: ${angle.label}
이유: ${angle.rationale}
검색어: ${angle.queries.join(" / ")}

이 각도에서 실제로 존재하는 경쟁 제품을 찾아라. 다른 각도는 다른 사람이 맡았으니 신경 쓰지 마라.`;
}

// ─────────────────────────────── 2단계 변형: 검색을 직접 조달하는 경로 (Serper)

export const SEARCH_FROM_RESULTS_SYSTEM = `너는 경쟁사를 찾아내는 리서처다. 아래에 주어진 검색 결과만 근거로 삼는다.

지켜야 할 것:
- 검색 결과에 없는 회사는 쓰지 마라. 기억에서 꺼낸 유명 회사를 채워 넣는 것이 이 작업의 가장 큰 실패다.
- 큰 회사 1개보다 작은 회사 5개가 훨씬 가치 있다. 창업자는 자기와 비슷한 크기의 경쟁자를 알고 싶어 한다.
  Product Hunt, Indie Hackers, Reddit 스레드, "alternatives to X" 페이지, 비교 글에서 나오는 이름들을 특히 주목해라.
- 너는 스니펫만 보고 있다. 스니펫에서 확인되지 않는 것을 단정하지 마라 —
  기능이나 규모가 불확실하면 불확실하다고 적어라. 그것도 정보다.
- 스니펫에 리뷰 사이트(G2·Capterra·Product Hunt·앱스토어)나 가격 정보, 커뮤니티 언급이 보이면
  그 제품이 실제로 굴러가고 있다는 신호다. 보이는 대로 적어라. 안 보이면 안 보인다고 적어라.
  흔적이 없다고 후보에서 빼지는 마라 — 구분되게 적기만 하면 된다.
- 검색 결과가 이 각도와 무관하면 억지로 채우지 말고 못 찾았다고 써라.

출력 형식: 찾은 제품마다 이름, 홈페이지 URL, 한 줄 설명, 이 아이디어와 겹치는 지점, 회사 규모 인상,
**실사용 흔적(어디서 확인했는지 / 못 찾았는지)**, 그리고 그 판단의 근거가 된 URL을 적어라.
산문으로 써도 되지만 제품 단위로 구분되게 써라.`;

export function searchFromResultsUser(
  refined: RefinedIdea,
  angle: Angle,
  results: { query: string; hits: { title: string; url: string; snippet: string }[] }[],
): string {
  const block = results
    .map(({ query, hits }) =>
      [
        `▼ 검색어: ${query}`,
        ...hits.map((h) => `  · ${h.title}\n    ${h.url}\n    ${h.snippet}`),
      ].join("\n"),
    )
    .join("\n\n");

  return `${anglePrompt(refined, angle)}

아래는 이 각도로 실제 검색한 결과다. 이것만 근거로 삼아라.

${block}`;
}

// ─────────────────────────────── 3단계: 구조화

export const EXTRACT_SYSTEM = `너는 리서치 노트를 구조화된 레코드로 옮기는 작업을 한다.

규칙:
- 노트에 없는 회사를 만들어내지 마라. 네 배경지식으로 보충하지도 마라. 노트에 있는 것만 옮긴다.
- 근거 URL이 하나도 없는 후보는 confidence를 low로 내려라.
- 노트가 어떤 회사를 "잘 모르겠다"고 적었으면 relation을 unclear로 둬라. 억지로 분류하지 마라.
- 노트에서 아무 회사도 못 건졌으면 candidates를 빈 배열로 두고 notes에 그 사실을 적어라.

traction 판정 (후보를 빼는 기준이 아니라 분류하는 기준이다):
- confirmed: 노트에 리뷰 사이트·가격 페이지·커뮤니티 언급 등 실사용 흔적이 적혀 있다
- weak: 홈페이지나 제품 설명은 있으나 실사용 흔적은 확인되지 않았다
- none: 리스티클/대안 목록에 이름만 등장하고 그 이상 아무것도 없다
traction_evidence에는 그렇게 판단한 근거를 적는다. none이면 무엇이 없어서 그렇게 봤는지 적어라.
review_sources에는 리뷰가 실제로 존재한다고 노트에서 확인된 곳만 넣는다. 추측으로 채우지 마라.
  소문자 슬러그로 적는다(예: g2, capterra, google_reviews, app_store, reddit, youtube).
  이 업계의 리뷰가 어디에 있는지는 업계마다 다르다 — SaaS면 G2/Capterra, 앱이면 스토어,
  지역 서비스업이면 구글 리뷰나 업계 전문 포럼이다. 실제로 본 곳을 그대로 적어라.`;

export function extractUser(findings: AngleFindings): string {
  const sourceList = findings.sources
    .slice(0, 60)
    .map((s) => `- ${s.title} — ${s.url}`)
    .join("\n");

  return `검색 각도: ${findings.angle.kind} — ${findings.angle.label}

리서치 노트:
---
${findings.text}
---

이 노트를 쓸 때 실제로 열어본 검색 결과:
${sourceList || "(없음)"}

노트에 등장한 제품들을 레코드로 옮겨라.`;
}

// ─────────────────────────────── 4단계: 병합·정제

export const CONSOLIDATE_SYSTEM = `너는 여러 각도에서 모은 경쟁사 후보 목록을 하나로 정리한다.

해야 할 일:
- 답은 후보 번호로 한다. 이름·URL·설명은 이미 기록돼 있으니 다시 쓰지 마라 — 판단만 하면 된다.
- 같은 회사가 다른 이름/표기로 중복되어 있으면 대표 하나를 keep에 넣고 나머지 번호를 merge에 넣어라.
- 이 아이디어의 경쟁사가 아닌 것을 걸러내라. 걸러낸 것은 반드시 excluded에 이유와 함께 남겨라.
  제외 사유는 "이 아이디어의 경쟁 상대가 아님"에 한정한다 — 검색 노이즈, 폐업, 전혀 다른 시장, 공급자/인프라 계층 등.
- **실사용 흔적이 없다는 이유로는 제외하지 마라.** 초기 단계 제품이나 실존이 불확실한 것도
  창업자가 알아야 할 정보다. traction을 none/weak으로 표시해서 남겨라 — 리포트에서 티어로 나눌 것이다.
- traction은 후보 레코드의 값을 검토해서 최종 판정한다. 여러 각도에서 잡혔으면 더 강한 쪽을 택하되
  (confirmed > weak > none), 근거가 실제로 있는 경우에 한해서다.
  근거가 자사 블로그·랜딩페이지뿐이라면 confirmed로 올리지 말고, note에 무엇이 미확인인지 적어라.
- 여러 각도에서 동시에 잡힌 회사는 진짜 경쟁사일 확률이 높다. found_by_angles에 그대로 기록해라.
- 정렬은 코드가 하므로 순서는 신경 쓰지 마라.
- coverage_gaps에는 이번 결과에서 비어 보이는 영역을 적어라. 특히 다음을 점검해라:
  후보가 전부 대기업뿐인가? 전부 미국 제품인가? 특정 각도에서만 결과가 나왔는가?

절대 하지 말 것: 목록에 없는 회사를 추가하는 것. 정리만 하고 발명하지 마라.`;

export function consolidateUser(
  refined: RefinedIdea,
  pooled: { candidate: Candidate; angles: string[] }[],
): string {
  const listing = pooled
    .map(({ candidate, angles }, i) =>
      [
        `[${i}] ${candidate.name} (${candidate.url || "URL 없음"})`,
        `   설명: ${candidate.one_liner}`,
        `   관계: ${candidate.relation} / 규모: ${candidate.size_hint} / 확신도: ${candidate.confidence}`,
        `   실사용 흔적: ${candidate.traction} — ${candidate.traction_evidence}`,
        `   리뷰 소스: ${candidate.review_sources.join(", ") || "확인 안 됨"}`,
        `   겹치는 지점: ${candidate.why_competitor}`,
        `   발견된 각도: ${angles.join(", ")}`,
        `   근거: ${candidate.evidence_urls.slice(0, 4).join(" , ") || "없음"}`,
      ].join("\n"),
    )
    .join("\n\n");

  return `원래 아이디어가 푸는 문제:
${refined.restated_problem}

타겟 유저: ${refined.target_user}

모은 후보 (${pooled.length}개, 대괄호 안이 번호):
${listing}

정리해라. 답에는 번호만 쓰고 이름·URL·설명은 다시 쓰지 마라.`;
}

// ─────────────────────────────── 5단계: 리뷰 기반 강약점

export const REVIEW_SYSTEM = `너는 특정 제품에 대해 사람들이 실제로 한 말을 정리한다.

지켜야 할 것:
- 주어진 검색 결과에 실제로 있는 말만 쓴다. 제품 소개 문구나 마케팅 카피는 사용자 목소리가 아니다.
  "빠르고 직관적입니다" 같은 자사 홍보 문구를 강점으로 옮기지 마라.
- 각 항목에는 실제 표현을 quote에 그대로 담고, 그 말이 나온 URL을 source_url에 적는다.
  quote를 지어내거나 다듬지 마라. 원문이 영어면 영어 그대로 둔다.
- 사용자 목소리가 없으면 strengths/weaknesses를 빈 배열로 두고 sentiment를 insufficient로 한다.
  이 경우가 흔하다. 초기 제품은 리뷰가 없는 게 정상이고, "없다"는 것도 창업자에게 정보다.
- 한두 명의 의견과 반복되는 패턴을 구분해라. 반복되는 것을 우선하고,
  단발성이면 note에 그렇다고 적어라.
- 별점이나 평점은 중요하지 않다. 무엇을 좋아하고 무엇을 아쉬워하는지가 핵심이다.

sentiment 판정:
- mostly_positive: 긍정적 언급이 뚜렷하게 많다
- mixed: 좋아하는 점과 불만이 둘 다 뚜렷하다
- mostly_negative: 불만이 뚜렷하게 많다
- insufficient: 사용자 목소리를 찾지 못했다 (마케팅 문구만 있는 경우 포함)`;

export function reviewUser(
  competitorName: string,
  oneLiner: string,
  results: { query: string; hits: { title: string; url: string; snippet: string }[] }[],
): string {
  const block = results
    .map(({ query, hits }) =>
      [
        `▼ 검색어: ${query}`,
        ...hits.map((h) => `  · ${h.title}\n    ${h.url}\n    ${h.snippet}`),
      ].join("\n"),
    )
    .join("\n\n");

  return `제품: ${competitorName}
설명: ${oneLiner}

아래는 이 제품에 대해 검색한 결과다. 여기서 사용자들이 실제로 한 말만 골라내라.

${block || "(검색 결과 없음)"}`;
}

// ─────────────────────────────── 6단계: 차별점 매핑

export const POSITIONING_SYSTEM = `너는 경쟁사 목록을 보고 이 시장이 실제로 어떤 축으로 갈리는지 찾아낸다.

가장 흔한 실패는 이것이다: "혁신성 vs 안정성" 같은 그럴듯한 2x2를 만드는 것.
컨설팅 슬라이드처럼 보이지만 창업자에게 아무 정보가 없다.

따라서:
- 축은 자료에서 반복해서 나타난 것만 만들어라. 가격이 여러 번 언급됐으면 가격이 축이고,
  타겟 규모가 갈리면 그것이 축이다. why에 그 근거를 적어라 — 근거를 댈 수 없으면 축을 만들지 마라.
- 축은 2개, 많아야 3개다. 많을수록 지도가 아니라 표가 된다.
- 각 경쟁사를 축 위에 놓을 때도 근거를 적어라. 자료에 정보가 없으면 unknown으로 두고
  "가격 정보 없음"처럼 그렇게 적어라. 추측으로 채우지 마라.
- gaps는 실제로 비어 있는 조합만. 그리고 비어 있는 게 기회인지, 아니면 그 자리에 시장이
  없어서인지 판단해서 assessment에 적어라. 빈칸이 곧 기회는 아니다.
- contested에는 경쟁사들이 실제로 겨루는 지점을 적어라. 리뷰에서 같은 불만이 반복됐다면
  그것이 이 시장의 미해결 지점이다.
- your_position은 단정하지 마라. 입력한 아이디어는 아직 제품이 아니라 설명일 뿐이므로,
  caveat에 무엇을 확인해야 하는지 적어라.`;

export function positioningUser(
  refined: RefinedIdea,
  competitors: {
    name: string;
    one_liner: string;
    relation: string;
    size_hint: string;
    traction: string;
    why_competitor: string;
  }[],
  reviews: { competitor: string; strengths: string[]; weaknesses: string[] }[],
): string {
  const list = competitors
    .map(
      (c) =>
        `- ${c.name} [${c.relation}/${c.size_hint}] ${c.one_liner}\n    겹침: ${c.why_competitor}`,
    )
    .join("\n");

  const reviewBlock = reviews.length
    ? reviews
        .map(
          (r) =>
            `- ${r.competitor}\n    좋아하는 점: ${r.strengths.join(" / ") || "없음"}\n    아쉬운 점: ${r.weaknesses.join(" / ") || "없음"}`,
        )
        .join("\n")
    : "(리뷰 분석을 돌리지 않아 자료 없음)";

  return `입력된 아이디어:
${refined.restated_problem}

타겟 유저: ${refined.target_user}

경쟁사 (${competitors.length}개):
${list}

리뷰에서 나온 강약점:
${reviewBlock}

이 시장이 어떤 축으로 갈리는지 찾고, 경쟁사들을 그 위에 놓아라.`;
}
