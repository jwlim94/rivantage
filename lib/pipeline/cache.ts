import fs from "node:fs";
import path from "node:path";

/**
 * 단계별 결과를 디스크에 남긴다. 프롬프트를 고칠 때마다 웹서치를 처음부터 다시 도는 걸 막는 용도다.
 * 캐시 키에 입력 해시를 넣지 않으므로, 아이디어 텍스트를 바꿨으면 --no-cache로 돌리거나 cache/<id>를 지워야 한다.
 */
export type Cache = <T>(
  key: string,
  fn: () => Promise<T>,
  /**
   * 캐시된 값이 현재 스키마와 맞는지 확인한다. null을 반환하면 캐시를 버리고 다시 실행한다.
   * 스키마를 바꿨을 때 구버전 캐시를 읽고 터지는 걸 막는다.
   */
  validate?: (cached: unknown) => T | null,
) => Promise<T>;

export function makeCache(
  runId: string,
  opts: { enabled: boolean; refresh: Set<string> },
  onHit: (key: string) => void,
): Cache {
  const dir = path.join("cache", runId);

  return async function cached<T>(
    key: string,
    fn: () => Promise<T>,
    validate?: (cached: unknown) => T | null,
  ): Promise<T> {
    const file = path.join(dir, `${key}.json`);
    // key는 "extract-0-direct_category" 형태 — 앞부분이 단계 이름이다.
    const stage = key.split("-")[0]!;
    const enabled = opts.enabled && !opts.refresh.has(stage);
    if (enabled && fs.existsSync(file)) {
      const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      const checked = validate ? validate(raw) : (raw as T);
      if (checked !== null) {
        onHit(key);
        return checked;
      }
      console.log(`  ↻ ${key}: 스키마가 바뀌어 캐시를 버리고 다시 실행한다`);
    }
    const result = await fn();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(result, null, 2));
    return result;
  };
}
