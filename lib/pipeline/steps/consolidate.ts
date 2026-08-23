import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { track, type Spend } from "../cost.js";
import { CONSOLIDATE_SYSTEM, consolidateUser } from "../prompts.js";
import {
  anthropicClient,
  assertNotRefused,
  fromAnthropic,
  requestOptionsFor,
} from "../providers/anthropic.js";
import {
  AngleKind,
  ConsolidateDecision,
  type Consolidated,
  type Candidate,
  type RefinedIdea,
} from "../types.js";

type Kind = z.infer<typeof AngleKind>;

/** 도메인이 같으면 같은 회사로 본다. LLM에 넘기기 전 명백한 중복을 줄여 토큰을 아낀다. */
function domainKey(c: Candidate): string {
  const raw = c.url?.trim();
  if (raw) {
    try {
      const host = new URL(raw.startsWith("http") ? raw : `https://${raw}`).hostname;
      return host.replace(/^www\./, "").toLowerCase();
    } catch {
      /* URL이 깨졌으면 이름으로 떨어진다 */
    }
  }
  return c.name.trim().toLowerCase().replace(/\s+/g, "");
}

export type Pooled = { candidate: Candidate; angles: Kind[] };

export function poolCandidates(perAngle: { kind: Kind; candidates: Candidate[] }[]): Pooled[] {
  const byKey = new Map<string, Pooled>();
  for (const { kind, candidates } of perAngle) {
    for (const candidate of candidates) {
      const key = domainKey(candidate);
      const hit = byKey.get(key);
      if (!hit) {
        byKey.set(key, { candidate, angles: [kind] });
        continue;
      }
      if (!hit.angles.includes(kind)) hit.angles.push(kind);
      // 근거가 더 많은 쪽을 대표 레코드로 남긴다.
      if (candidate.evidence_urls.length > hit.candidate.evidence_urls.length) {
        hit.candidate = candidate;
      }
    }
  }
  return [...byKey.values()];
}

/**
 * LLM의 판단(번호 기반)과 후보 레코드를 합쳐 최종 리포트를 만든다.
 * 이름·URL·근거 URL은 extract가 만든 값을 그대로 쓴다 — LLM이 재작성하며 바꿀 여지를 없앤다.
 */
function assemble(pooled: Pooled[], decision: ConsolidateDecision): Consolidated {
  const at = (i: number) => (i >= 0 && i < pooled.length ? pooled[i] : undefined);
  const RANK = { direct: 0, adjacent: 1, substitute: 2, unclear: 3 } as const;
  const uniq = <T,>(xs: T[]) => [...new Set(xs)];

  const competitors = decision.keep.flatMap((d) => {
    const head = at(d.index);
    if (!head) return []; // LLM이 범위 밖 번호를 냈으면 버린다
    const merged = d.merge.map(at).filter((x): x is Pooled => x !== undefined);
    const all = [head, ...merged];

    return [
      {
        ...head.candidate,
        relation: d.relation,
        traction: d.traction,
        // 유보 사항이 있으면 앞세우고 원래 근거를 뒤에 붙여 둘 다 남긴다.
        traction_evidence: d.note
          ? `${d.note} (원 근거: ${head.candidate.traction_evidence})`
          : head.candidate.traction_evidence,
        evidence_urls: uniq(all.flatMap((p) => p.candidate.evidence_urls)),
        review_sources: uniq(all.flatMap((p) => p.candidate.review_sources)),
        aliases: uniq(merged.map((p) => p.candidate.name)),
        found_by_angles: uniq(all.flatMap((p) => p.angles)),
      },
    ];
  });

  competitors.sort((a, b) => RANK[a.relation] - RANK[b.relation]);

  const excluded = decision.excluded.flatMap((e) => {
    const p = at(e.index);
    return p ? [{ name: p.candidate.name, reason: e.reason }] : [];
  });

  return { competitors, excluded, coverage_gaps: decision.coverage_gaps };
}

export async function consolidate(
  refined: RefinedIdea,
  pooled: Pooled[],
  spend: Spend,
  opts: { model: string },
): Promise<Consolidated> {
  if (pooled.length === 0) {
    return { competitors: [], excluded: [], coverage_gaps: ["모든 각도에서 후보를 하나도 못 찾음"] };
  }

  const stream = anthropicClient().beta.messages.stream({
    model: opts.model,
    max_tokens: 32000,
    ...requestOptionsFor(opts.model, 32000),
    system: CONSOLIDATE_SYSTEM,
    messages: [{ role: "user", content: consolidateUser(refined, pooled) }],
    output_config: { format: betaZodOutputFormat(ConsolidateDecision) },
  });

  // stream()은 자동 파싱을 해주지 않는다 — 직접 꺼내서 스키마로 검증한다.
  const msg = await stream.finalMessage();
  assertNotRefused(msg, "consolidate");
  track(spend, "consolidate", opts.model, fromAnthropic(msg.usage));

  const raw = msg.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");

  if (msg.stop_reason === "max_tokens") {
    throw new Error(
      `[consolidate] max_tokens에서 잘렸다 (후보 ${pooled.length}개). --angles를 줄이거나 max_tokens를 올려라.`,
    );
  }

  const parsed = ConsolidateDecision.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`[consolidate] 스키마 검증 실패: ${parsed.error.message}`);
  }

  const dropped =
    parsed.data.keep.filter((d) => d.index < 0 || d.index >= pooled.length).length +
    parsed.data.excluded.filter((e) => e.index < 0 || e.index >= pooled.length).length;
  if (dropped) console.log(`  ! consolidate: 범위 밖 번호 ${dropped}건 무시`);

  return assemble(pooled, parsed.data);
}
