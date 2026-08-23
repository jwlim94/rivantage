# Rivantage — 경쟁사 식별 파이프라인

아이디어를 자유 텍스트로 받아 이미 존재하는 경쟁사를 찾아내는 파이프라인. UI 없음, CLI만.

**목적은 제품을 만드는 게 아니라 "경쟁사 식별이 쓸 만한 정확도로, 감당 가능한 원가에 되는가"를 확인하는 것이다.**

현재 상태: 4개 도메인에서 검증 완료. 리포트 1건당 **$0.91**(경쟁사 식별) ~ **$1.36**(전체), 약 **5~7분**.

## 파이프라인

| 단계 | 파일 | 하는 일 | 기본 모델 |
|---|---|---|---|
| 1 | [steps/refine.ts](src/steps/refine.ts) | 아이디어 → 카테고리 + 검색 각도 4종 + 각도별 검색어 8개 | Opus 5 |
| 2 | [steps/search.ts](src/steps/search.ts) | 각도별 웹서치 → 리서치 노트 + 소스 URL (프로바이더에 위임) | Haiku 4.5 |
| 3 | [steps/extract.ts](src/steps/extract.ts) | 노트 → 구조화된 후보 레코드 | Haiku 4.5 |
| 4 | [steps/consolidate.ts](src/steps/consolidate.ts) | 병합·제외·티어 분류·커버리지 공백 | Opus 5 |
| 5 | [steps/reviews.ts](src/steps/reviews.ts) | 경쟁사별 강약점 + 인용 + 출처 URL (`--reviews`) | Haiku 4.5 |
| 6 | [steps/positioning.ts](src/steps/positioning.ts) | 시장이 갈리는 축 + 경쟁사 배치 + 빈자리 (`--positioning`) | Opus 5 |

### 설계 결정 다섯 가지

**1. 검색 각도를 4종으로 강제 분리** — `direct_category` / `problem_solving` / `substitute` / `adjacent`.
카테고리명 검색 하나만 돌리면 니치 영역에서 대기업만 나온다. `substitute` 각도는 소프트웨어가 아닌 것
(엑셀 템플릿, 프리랜서, 종이 태그)까지 잡는데, 도예 공방 케이스에서는 이게 최대 경쟁 축이었다.

**2. 검색어를 1단계에서 확정** — 검색 단계에서 매번 새로 만들면 같은 아이디어가 실행할 때마다 다른 리포트를 낸다.
refine이 각도당 검색어 8개를 만들고 캐시하므로 재현 가능하다.

**3. 검색과 구조화를 분리** — 검색 단계에서 스키마를 채우라고 하면 모델이 빈칸을 메우려고 회사를 지어낸다.
검색은 산문으로 받고, 구조화는 검색 결과를 못 보는 별도 호출이 맡는다.

**4. consolidate는 판단만 출력** — 이름·URL·설명은 extract가 만든 값을 코드가 복사한다.
LLM에게 다시 쓰게 하면 출력의 73%가 단순 복사에 쓰이고, 그 과정에서 이름이 미묘하게 바뀐다.
결정만 받게 바꿔서 이 단계 비용이 55% 줄었고 환각 경로가 사라졌다.

**5. 리뷰 분석은 인용과 출처를 강제한다** — 각 강점·약점에 실제 표현(`quote`)과 그 말이 나온 URL을
함께 담게 했다. 점수를 매기는 대신 근거를 보여주고 판단을 창업자에게 남기는 이 제품의 방향과 맞고,
동시에 환각을 막는다. 사용자 목소리를 못 찾으면 `sentiment: insufficient`로 정직하게 비운다 —
초기 제품은 리뷰가 없는 게 정상이고, 그 사실도 정보다.

**6. 포지셔닝 축은 근거가 있는 것만 만든다** — 가장 흔한 실패는 "혁신성 vs 안정성" 같은
그럴듯하지만 근거 없는 2x2를 그리는 것이다. 컨설팅 슬라이드처럼 보이지만 창업자에게 정보가 없다.
축과 배치 모두에 근거 필드를 강제하고, 자료에 없으면 `unknown`으로 비운다.
빈칸도 "기회"로 단정하지 않고 왜 비었는지 판단하게 한다 — 지불 의사가 없어서 빈 자리일 수 있다.

**7. 걸러내지 않고 티어로 나눈다** — 리뷰나 매출 흔적이 없는 초기 제품도 창업자가 알아야 할 정보다.
`traction`(confirmed / weak / none)으로 분류만 하고 제외하지 않는다. 제외는 "경쟁 상대가 아님"에만 쓴다.

## 코드 구조

프로바이더(모델·검색 공급자)에 의존하는 코드와 그렇지 않은 코드를 갈라놨다.

```
src/
  prompts.ts              모든 프롬프트 — 프롬프트 튜닝은 이 파일 하나에서 끝난다
  types.ts                zod 스키마 (LLM 출력의 계약서)
  cost.ts                 단계별 사용량 집계와 비용 계산
  cache.ts                단계별 결과 캐시 (스키마가 바뀌면 자동 무효화)
  providers/
    types.ts              SearchProvider 계약
    registry.ts           등록소 — 여기 배열에 한 줄 추가하면 CLI까지 전부 반영된다
    anthropic.ts          Anthropic 클라이언트 + 서버사이드 웹서치
    serper.ts             Serper 검색 + Claude 판단 (기본값)
    grok.ts               xAI Grok 서버사이드 웹서치
  steps/                  6단계. 프로바이더를 직접 알지 못한다
  run.ts                  CLI와 오케스트레이션
```

### 새 프로바이더 추가하기

`src/providers/<이름>.ts`에 `SearchProvider`를 만족하는 객체를 만들고 [registry.ts](src/providers/registry.ts)의
`REGISTRY` 배열에 추가한다. CLI 플래그 목록, 단가 계산, 기본 모델, 캐시 키 분리가 전부 등록 정보에서 파생된다.

프로바이더마다 서버사이드 웹서치의 기능이 다르다 — Anthropic은 `max_uses`로 검색 횟수를 묶을 수 있지만
xAI는 그런 파라미터가 없다. `supportsSearchLimit`으로 이 차이를 표시하고 실행 로그에 명시된다.

**아직 추상화하지 않은 것:** refine/extract/consolidate는 Anthropic 전용이다.
구조화 출력 방식이 프로바이더마다 달라서, 두 번째 구현이 실제로 필요해지기 전까지는 나누지 않았다.

## 실행

```bash
cp .env.example .env      # ANTHROPIC_API_KEY, SERPER_API_KEY를 넣는다

npm run dev -- --fixture rivantage-itself --search-provider=serper
npm run dev -- "내 아이디어 텍스트" --search-provider=serper
npm run dev -- --all --search-provider=serper
```

주요 옵션:

```
--search-provider=X     serper(기본 권장) / anthropic / grok
--angles=1              검색 각도 kind당 개수 (총 4종 × N)
--searches=8            각도당 검색어 수
--angle=direct_category 한 kind만 실행 (비용 측정용)
--refresh=extract,...   특정 단계만 캐시 무효화
--no-cache              전부 다시 실행
--extract-model=X       단계별 모델 오버라이드
--reviews               5단계: 리뷰 기반 강약점 (약 $0.15 추가)
--positioning           6단계: 차별점 매핑 (약 $0.30 추가)
--full                  5·6단계 모두 실행
--review-top=12         리뷰를 분석할 경쟁사 수 상한
--position-top=25       지도에 올릴 경쟁사 수 상한
```

결과는 `out/<id>.<provider>.json`에 저장된다. 각 각도의 원문 검색 노트와 열어본 소스 URL이
그대로 들어 있어 후보의 출처를 역추적할 수 있다.

## 검증 결과

4개 도메인, 각 1회 실행. 도메인 성격에 따라 지형이 완전히 다르게 나온다.

| 도메인 | 경쟁사 | direct | 대기업 | confirmed | 제외 | 비용 |
|---|---|---|---|---|---|---|
| SaaS (rivantage 자체) | 46 | 14 | 8 | 15 | 11 | ~$0.8 |
| B2B 버티컬 (HVAC 견적) | 41 | 10 | 2 | 16 | 16 | ~$0.8 |
| 오프라인 소상공 (도예 공방) | 36 | 7 | 1 | 9 | 7 | $0.82 |
| 규제 산업 (임상시험) | 57 | 17 | 16 | 15 | 8 | $1.00 |

**대기업 수가 1 → 2 → 8 → 16으로 도메인에 따라 달라진다** — 파이프라인이 인디 제품만 찾도록
과교정되지 않았다는 뜻이다. 시장에 대기업이 실제로 있으면 잡고, 없으면 안 잡는다.

리트머스 케이스(`rivantage-itself`)에서 사전에 알고 있던 경쟁사 IdeaProof / ValidatorAI / Competely를
모두 `direct`로 검출했다. IdeaValidation.ai는 놓쳤다.

리뷰 소스도 도메인마다 다르게 나온다 — SaaS는 reddit·hacker_news, HVAC은 youtube·facebook·app_store,
도예는 pinterest, 임상은 capterra·g2. 이 값이 그대로 5단계 검색어를 조준하는 데 쓰인다.

### 차별점 매핑 (임상시험 케이스, 대상 25개)

데이터에서 축 3개를 찾아냈고 각각 근거를 댔다. 특히 **편차 대응 시점**(사후 기록 ←→ 사전 예측 경고)은
설계 시 예상하지 못한 축인데, 여러 제품 설명에서 반복적으로 대비되어 나타난 것을 잡아낸 것이다.

빈칸을 기회로 단정하지 않는다:

> 형식적으로는 비어 있으나 '기회'로 단정할 수 없다. 소규모 사이트는 이미 CTMS 예산을 한 번 쓴 상태이고,
> 스케줄링 하나만을 위해 두 번째 구독을 승인할 구매자가 있는지가 검증되지 않았다.

입력한 아이디어의 위치도 마찬가지다:

> 이 자리는 완전히 비어 있지 않다 — Cloudbyz와 Site Copilot이 사전 경고를 이미 같은 문장으로 말하고 있다.

### 리뷰 분석 (임상시험 케이스, 대상 12개)

근거를 확보한 것은 6개(50%). 나머지는 실제로 사용자 목소리가 없는 초기 제품이라 `insufficient`로 비웠다.
인용 16건의 출처는 reddit 12 / capterra 2 / app_store 1 / facebook 1이며, 전부 실제 URL을 달고 있다.

실제 산출 예:

```
OnCore  [mixed]
  + "It's great for tracking and scheduling visits, reminding of visits"
  − "OnCore is even more expensive. Would not recommend for that reason"
  − "Look for a CTMS that lets you make changes individually per-study
     rather than having to apply one template..."
```

## 비용

리포트 1건당 약 **$0.91** (Anthropic $0.88 + Serper $0.03).

```
refine        Opus 5      $0.09    10%
search        Haiku 4.5   $0.21    23%   (웹서치 32회 포함)
extract       Haiku 4.5   $0.26    29%
consolidate   Opus 5      $0.32    35%
──────────────────────────────────────
reviews       Haiku 4.5   $0.15          (--reviews)
positioning   Opus 5      $0.30          (--positioning)
──────────────────────────────────────
전체 (--full)             $1.36
```

초기 구현($4.86)에서 81% 줄인 값이다. 주요 절감 요인:

- **검색을 직접 조달** — 서버사이드 웹서치는 모델이 페이지 본문을 읽어 컨텍스트에 쌓는다(실측 input 460k).
  Serper로 검색하고 스니펫만 넘기면 input이 30k로 줄어든다. 대신 판단 근거가 얇아지는 트레이드오프가 있다.
- **단계별 모델 분리** — extract는 기계적 작업이라 Haiku로 충분하다(실측상 판정 차이 없음).
  consolidate를 Haiku로 내리면 "홈페이지가 있다"를 실사용 흔적으로 치는 과잉 판정이 나오므로 Opus를 유지한다.
- **consolidate 출력 축소** — 판단만 받고 나머지는 코드가 조립.

## 알려진 한계

- **`IdeaValidation.ai`를 못 찾는다.** 검색어 8개를 한 번에 던지고 끝나는 구조라 결과를 보고 방향을 틀 수 없다.
  `coverage_gaps`를 2라운드 검색어로 되먹이면 개선될 수 있으나 아직 구현하지 않았다.
- **실행 간 편차가 있다.** 검색어는 고정했지만 검색 결과 자체가 시시각각 변하고 LLM 판정에도 흔들림이 남는다.
  모델 조합을 비교할 때는 2~3회 돌려서 봐야 한다.
- **`traction: confirmed`의 근거가 자사 블로그인 경우가 많다.** Opus는 "제3자 리뷰 미확인" 같은 유보를
  붙이지만, 제3자 리뷰 플랫폼을 직접 확인하는 검증 라운드는 없다.
- **Reddit 스레드 본문은 가져오지 못한다.** 무인증 `.json` 접근이 403으로 차단되어 있어
  (`old.reddit.com`, User-Agent 변경, 검색 엔드포인트 모두 동일) 구글 검색 스니펫만 사용한다.
  OAuth를 붙이면 기술적으로는 가능하나 상업적 사용은 별도 라이선스 대상이라 보류했다.
- **리뷰 근거 확보율이 50% 수준이다.** 절반은 실제로 리뷰가 없는 초기 제품이지만,
  스니펫만 보는 구조라 놓치는 것도 있다.
- **포지셔닝 지도에 unknown이 많다.** 특히 가격 축은 대상 25개 중 절반 이상이 미확인이다.
  추측으로 채우지 않은 결과지만 그만큼 지도가 성기다.
- **정확도를 잰 것은 리트머스 케이스 하나뿐이다.** 나머지 3개 도메인은 정답을 모르는 상태라
  "결과가 말이 된다"는 판단이지 재현율을 측정한 것이 아니다.

## 아직 없는 것

MVP 스코프 중 **성장 추세**만 남았다.

- ~~리뷰 기반 강약점~~ → 구현 완료 (`--reviews`)
- ~~경쟁사 간 공통점·차별점 매핑~~ → 구현 완료 (`--positioning`)
- 창업 시기·성장 추세 (SimilarWeb 등 유료 API가 필요할 수 있다)
