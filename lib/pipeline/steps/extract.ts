import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { track, type Spend } from "../cost.js";
import { EXTRACT_SYSTEM, extractUser } from "../prompts.js";
import {
  anthropicClient,
  assertNotRefused,
  fromAnthropic,
  requestOptionsFor,
} from "../providers/anthropic.js";
import type { AngleFindings } from "../providers/types.js";
import { ExtractedCandidates } from "../types.js";

export async function extractCandidates(
  findings: AngleFindings,
  spend: Spend,
  opts: { model: string },
): Promise<ExtractedCandidates> {
  if (!findings.text.trim()) {
    return { candidates: [], notes: `검색 각도 ${findings.angle.kind}: 모델이 아무 텍스트도 내지 않음` };
  }

  // 후보가 많은 각도는 출력이 길어 16k로는 잘린다. 스트리밍이면 큰 max_tokens에서도 타임아웃 가드에 안 걸린다.
  const MAX_TOKENS = 32000;
  const stream = anthropicClient().beta.messages.stream({
    model: opts.model,
    max_tokens: MAX_TOKENS,
    ...requestOptionsFor(opts.model, MAX_TOKENS),
    system: EXTRACT_SYSTEM,
    messages: [{ role: "user", content: extractUser(findings) }],
    output_config: { format: betaZodOutputFormat(ExtractedCandidates) },
  });

  const msg = await stream.finalMessage();
  const where = `extract:${findings.angle.kind}`;
  assertNotRefused(msg, where);
  track(spend, "extract", opts.model, fromAnthropic(msg.usage));

  const raw = msg.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");

  // 실패 원인을 구분해서 알려준다 — "파싱 실패"만으로는 잘린 건지 형식이 틀린 건지 알 수 없다.
  if (msg.stop_reason === "max_tokens") {
    throw new Error(`[${where}] max_tokens(${MAX_TOKENS})에서 잘렸다. 소스 ${findings.sources.length}개.`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new Error(
      `[${where}] JSON 파싱 실패 (stop_reason=${msg.stop_reason}, ${raw.length}자)\n  앞부분: ${raw.slice(0, 200)}`,
    );
  }

  const parsed = ExtractedCandidates.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(`[${where}] 스키마 검증 실패: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join(" / ")}`);
  }
  return parsed.data;
}
