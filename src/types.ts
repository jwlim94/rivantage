import { z } from "zod";

/**
 * 검색 각도. 니치 카테고리에서 LLM이 유명 대기업만 뱉는 걸 막으려면
 * "카테고리명으로 검색" 하나만으로는 부족하다 — 문제 해결 방식과 대체재 축을 강제로 분리한다.
 */
export const AngleKind = z.enum([
  "direct_category", // 업계에서 실제 쓰는 카테고리명으로 직접 검색
  "problem_solving", // 같은 문제를 다른 방식으로 푸는 제품
  "substitute", // 제품이 아닌 대체재 (스프레드시트, 대행사, 수작업)
  "adjacent", // 인접 카테고리에서 이 영역으로 넘어올 수 있는 제품
]);

export const SearchAngle = z.object({
  kind: AngleKind,
  label: z.string().describe("이 각도가 무엇을 찾으려는지 한 줄 설명"),
  /**
   * 이 각도로 실제 던질 검색어들. 여기서 한 번에 확정하는 이유는 재현성이다 —
   * 검색 단계에서 매번 새로 만들면 같은 아이디어가 실행할 때마다 다른 리포트를 낸다.
   */
  queries: z
    .array(z.string())
    .describe("실제로 검색 엔진에 넣을 검색어들. 영어. 서로 다른 결과 집합을 끌어와야 한다."),
  rationale: z.string().describe("왜 이 각도가 경쟁사를 드러내는지"),
});

export const RefinedIdea = z.object({
  restated_problem: z.string().describe("아이디어가 푸는 문제를 한 문단으로 재진술"),
  target_user: z.string().describe("누가 돈을 내는가"),
  category_labels: z
    .array(z.string())
    .describe("이 제품이 속한 카테고리를 업계에서 부르는 이름들. 영어. 2~5개."),
  jobs_to_be_done: z.array(z.string()).describe("유저가 이걸로 끝내려는 일. 3~6개."),
  angles: z.array(SearchAngle).describe("검색 각도. 각 kind가 최소 1개씩 포함되어야 함."),
});
export type RefinedIdea = z.infer<typeof RefinedIdea>;

export const Relation = z.enum(["direct", "adjacent", "substitute", "unclear"]);

/**
 * 실제로 굴러가고 있다는 흔적.
 * 후보를 걸러내는 용도가 아니라 리포트를 티어로 나누는 용도다 —
 * "리뷰 있는 확인된 경쟁사"와 "이름만 있는 초기 단계"는 창업자에게 의미가 다르다.
 */
export const Traction = z.enum([
  "confirmed", // 리뷰·가격 페이지·커뮤니티 언급 등 실사용 흔적이 확인됨
  "weak", // 홈페이지는 살아 있으나 실사용 흔적을 못 찾음
  "none", // 이름만 등장. 실존 자체가 미확인
]);
export const SizeHint = z.enum(["indie", "startup", "scaleup", "enterprise", "unknown"]);
export const Confidence = z.enum(["high", "medium", "low"]);

export const Candidate = z.object({
  name: z.string(),
  url: z.string().describe("제품 홈페이지. 모르면 빈 문자열."),
  one_liner: z.string().describe("이 제품이 뭘 하는지 한 줄"),
  relation: Relation,
  why_competitor: z.string().describe("이 아이디어와 어디서 겹치는지 구체적으로"),
  evidence_urls: z.array(z.string()).describe("검색 결과에서 실제로 본 근거 URL"),
  size_hint: SizeHint,
  confidence: Confidence.describe("이 회사가 실존하고 관련 있다는 확신도"),
  traction: Traction,
  traction_evidence: z
    .string()
    .describe("traction을 그렇게 판단한 근거. 못 찾았으면 무엇을 찾아봤는데 없었는지 적는다."),
  /**
   * 리뷰가 사는 곳은 도메인마다 다르다 — SaaS는 G2/Capterra, 앱은 스토어,
   * 지역 서비스업은 구글 리뷰나 업계 포럼이다. 고정 목록으로 못 박으면 니치 버티컬에서 깨진다.
   * 그래서 자유 문자열로 받되 프롬프트에서 슬러그 형태를 요구한다.
   */
  review_sources: z
    .array(z.string())
    .describe(
      "이 회사 리뷰가 실제로 존재하는 것을 확인한 곳. 소문자 슬러그로 적는다 " +
        "(예: g2, capterra, trustpilot, producthunt, app_store, google_reviews, reddit, youtube, hvac_talk). " +
        "확인 못 했으면 빈 배열.",
    ),
});
export type Candidate = z.infer<typeof Candidate>;

export const ExtractedCandidates = z.object({
  candidates: z.array(Candidate),
  notes: z.string().describe("이 각도에서 건진 게 없거나 검색이 빗나갔으면 여기에 기록"),
});
export type ExtractedCandidates = z.infer<typeof ExtractedCandidates>;

export const ConsolidatedCompetitor = Candidate.extend({
  aliases: z.array(z.string()).describe("같은 회사를 가리키는 다른 표기"),
  found_by_angles: z.array(AngleKind).describe("어느 각도에서 발견됐는지"),
});

/**
 * consolidate가 LLM에게 요구하는 출력. **판단만** 담는다.
 *
 * 이름·URL·설명 같은 필드는 extract가 이미 만들었으므로 코드가 복사한다.
 * LLM에게 다시 타이핑시키면 출력 토큰의 73%가 단순 복사에 쓰이고,
 * 그 과정에서 이름이나 URL이 미묘하게 바뀌는 환각 위험도 생긴다.
 */
export const ConsolidateDecision = z.object({
  keep: z.array(
    z.object({
      index: z.number().describe("후보 목록에 붙은 번호"),
      merge: z.array(z.number()).describe("같은 회사라서 이 후보에 합칠 다른 번호들. 없으면 빈 배열."),
      relation: Relation.describe("최종 판정. 후보 레코드의 값을 바꿔도 된다."),
      traction: Traction.describe("최종 판정. 근거가 실제로 있는 경우에만 강한 쪽을 택한다."),
      note: z
        .string()
        .describe(
          "판정을 바꿨거나 근거에 유보가 있으면 여기에 적는다(예: 제3자 리뷰 미확인). 없으면 빈 문자열.",
        ),
    }),
  ),
  excluded: z
    .array(z.object({ index: z.number(), reason: z.string() }))
    .describe("경쟁 상대가 아니라고 판단한 후보의 번호와 이유"),
  coverage_gaps: z.array(z.string()).describe("이번 결과에서 비어 보이는 영역"),
});
export type ConsolidateDecision = z.infer<typeof ConsolidateDecision>;

/** 최종 리포트 형태. LLM이 아니라 코드가 조립한다. */
export const Consolidated = z.object({
  competitors: z.array(ConsolidatedCompetitor).describe("relation이 가까운 순으로 정렬"),
  excluded: z
    .array(z.object({ name: z.string(), reason: z.string() }))
    .describe("후보에 올랐지만 경쟁사가 아니라고 판단한 것과 그 이유"),
  coverage_gaps: z
    .array(z.string())
    .describe("이번 검색으로 못 덮은 영역. 다음 라운드 검색어의 재료가 된다."),
});
export type Consolidated = z.infer<typeof Consolidated>;
