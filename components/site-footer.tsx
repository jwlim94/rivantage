import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="border-t border-(--color-border) bg-(--color-surface)">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-8 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-(--color-ink-subtle)">
          Rivantage — 경쟁사 정보를 깊게, 판단은 창업자에게.
        </p>
        <nav className="flex gap-5 text-sm text-(--color-ink-muted)">
          <Link href="/how-it-works" className="transition-colors hover:text-(--color-ink)">
            어떻게 동작하나
          </Link>
          <Link href="/pricing" className="transition-colors hover:text-(--color-ink)">
            가격
          </Link>
        </nav>
      </div>
    </footer>
  );
}
