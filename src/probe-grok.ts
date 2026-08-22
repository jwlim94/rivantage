/**
 * Grok Responses API의 실제 응답 구조를 확인하는 최소 스크립트.
 * 검색 1회짜리 요청이라 비용이 거의 없다. 파이프라인을 돌리기 전에 이걸로
 * output_text / 인용 위치 / 서버툴 사용량 필드명을 확정한다.
 *
 *   npm run probe:grok
 */
import fs from "node:fs";
import OpenAI from "openai";

const apiKey = process.env.XAI_API_KEY?.trim();
if (!apiKey) {
  console.error("\n✗ XAI_API_KEY가 없습니다. .env에 추가하세요. 발급: https://console.x.ai\n");
  process.exit(1);
}

const client = new OpenAI({ apiKey, baseURL: "https://api.x.ai/v1", timeout: 600_000 });
const model = process.argv[2] ?? "grok-4.6";

console.log(`모델 ${model} 로 검색 1회 요청 중...\n`);

const res = await client.responses.create({
  model,
  instructions: "너는 리서처다. 웹 검색으로 확인된 사실만 답하고 근거 URL을 적어라.",
  input: [{ role: "user", content: "IdeaProof라는 스타트업 아이디어 검증 서비스에 대해 알려줘." }],
  tools: [{ type: "web_search" } as never],
});

const raw = res as unknown as Record<string, unknown>;

console.log("─".repeat(70));
console.log("최상위 키:", Object.keys(raw).join(", "));
console.log("─".repeat(70));
console.log("output_text 존재:", typeof res.output_text, `(${(res.output_text ?? "").length}자)`);
console.log("usage:", JSON.stringify(res.usage, null, 2));

const toolFields = Object.keys(raw).filter((k) => /tool|search|citation|source/i.test(k));
console.log("툴/인용 관련 최상위 키:", toolFields.length ? toolFields.join(", ") : "(없음)");

if (Array.isArray(res.output)) {
  console.log("\noutput 배열 아이템 타입:");
  for (const item of res.output as unknown as Record<string, unknown>[]) {
    console.log(`  - ${item.type}  (키: ${Object.keys(item).join(", ")})`);
  }
}

// URL이 어느 경로에 박혀 있는지 찾아서 보고한다.
const paths: string[] = [];
const walk = (node: unknown, path: string): void => {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === "string" && /^https?:\/\//.test(v)) paths.push(`${path}.${k}`);
    else walk(v, `${path}.${k}`);
  }
};
walk(raw, "res");
console.log(`\nURL이 발견된 경로 ${paths.length}개 (앞 15개):`);
for (const p of paths.slice(0, 15)) console.log(`  ${p}`);

fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/grok-probe.json", JSON.stringify(res, null, 2));
console.log("\n전체 응답 → out/grok-probe.json");
