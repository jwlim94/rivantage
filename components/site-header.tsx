import Link from "next/link";

/** 로그인 전 기준의 상단 바. 인증이 붙으면 우측 영역만 교체한다. */
const NAV = [
  { href: "/how-it-works", label: "어떻게 동작하나" },
  { href: "/pricing", label: "가격" },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-(--color-border) bg-(--color-canvas)/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-8 px-6">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="text-[15px] font-semibold tracking-tight">Rivantage</span>
          <span className="hidden text-xs text-(--color-ink-subtle) sm:inline">Rival + Vantage</span>
        </Link>

        <nav className="hidden items-center gap-6 sm:flex">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-sm text-(--color-ink-muted) transition-colors hover:text-(--color-ink)"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <Link
            href="/login"
            className="hidden text-sm text-(--color-ink-muted) transition-colors hover:text-(--color-ink) sm:inline"
          >
            로그인
          </Link>
          <Link
            href="/new"
            className="rounded-md bg-(--color-brand) px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-(--color-brand-hover)"
          >
            분석 시작
          </Link>
        </div>
      </div>
    </header>
  );
}
