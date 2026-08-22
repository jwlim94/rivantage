import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { track, type Spend } from "../cost.js";
import { REFINE_SYSTEM, refineUser } from "../prompts.js";
import {
  anthropicClient,
  assertNotRefused,
  fromAnthropic,
  requestOptionsFor,
} from "../providers/anthropic.js";
import { RefinedIdea } from "../types.js";

export async function refineIdea(
  idea: string,
  spend: Spend,
  opts: { anglesPerKind: number; queriesPerAngle: number; model: string },
): Promise<RefinedIdea> {
  const res = await anthropicClient().beta.messages.parse({
    model: opts.model,
    max_tokens: 16000,
    ...requestOptionsFor(opts.model, 16000),
    system: REFINE_SYSTEM,
    messages: [{ role: "user", content: refineUser(idea, opts.anglesPerKind, opts.queriesPerAngle) }],
    output_config: { format: betaZodOutputFormat(RefinedIdea) },
  });

  assertNotRefused(res, "refine");
  track(spend, "refine", opts.model, fromAnthropic(res.usage));

  if (!res.parsed_output) throw new Error("[refine] 구조화 출력 파싱 실패");
  return res.parsed_output;
}
