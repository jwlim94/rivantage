import Link from "next/link";

/** 랜딩. 컨텐츠(리포트 화면)는 아직 없고 제품이 뭘 하는지만 밝힌다. */
export default function Home() {
  return (
    <>
      <section className="mx-auto max-w-6xl px-6 pt-20 pb-16 sm:pt-28">
        <p className="mb-5 inline-flex rounded-full border border-(--color-border) bg-(--color-brand-subtle) px-3 py-1 text-xs font-medium text-(--color-brand)">
          점수를 매기지 않습니다
        </p>
        <h1 className="max-w-3xl text-4xl leading-[1.15] font-semibold tracking-tight text-balance sm:text-5xl">
          아이디어를 쓰면
          <br />
          이미 하고 있는 회사를 찾아냅니다
        </h1>
        <p className="prose-ko mt-6 max-w-xl text-lg text-(--color-ink-muted)">
          한 문단이면 충분합니다. 경쟁사를 발굴하고, 사용자들이 실제로 남긴 말에서 강점과 아쉬운
          점을 뽑고, 이 시장이 어떤 축으로 갈리는지 보여드립니다.
        </p>
        <div className="mt-9 flex flex-wrap items-center gap-3">
          <Link
            href="/new"
            className="rounded-md bg-(--color-brand) px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-(--color-brand-hover)"
          >
            분석 시작
          </Link>
          <Link
            href="/how-it-works"
            className="rounded-md border border-(--color-border-strong) px-5 py-2.5 text-sm font-medium text-(--color-ink) transition-colors hover:bg-(--color-surface)"
          >
            어떻게 동작하나
          </Link>
        </div>
      </section>

      <section className="border-t border-(--color-border) bg-(--color-surface)">
        <div className="mx-auto grid max-w-6xl gap-10 px-6 py-16 sm:grid-cols-3">
          {[
            {
              title: "네 방향으로 찾습니다",
              body: "카테고리명만 검색하면 큰 회사만 나옵니다. 같은 문제를 다른 방식으로 푸는 제품, 소프트웨어가 아닌 대체 수단까지 나눠서 찾습니다.",
            },
            {
              title: "근거를 함께 보여줍니다",
              body: "강점과 아쉬운 점마다 실제로 누가 어디서 한 말인지 링크가 붙습니다. 확인은 직접 하시면 됩니다.",
            },
            {
              title: "빈자리를 단정하지 않습니다",
              body: "비어 있는 자리가 늘 기회는 아닙니다. 아무도 안 해서인지, 돈을 낼 사람이 없어서인지 함께 짚습니다.",
            },
          ].map((f) => (
            <div key={f.title}>
              <h2 className="text-[15px] font-semibold">{f.title}</h2>
              <p className="prose-ko mt-2 text-sm text-(--color-ink-muted)">{f.body}</p>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
