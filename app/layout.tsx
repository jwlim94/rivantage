import type { Metadata } from "next";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Rivantage — 경쟁사를 먼저 본다",
    template: "%s · Rivantage",
  },
  description:
    "사업 아이디어를 입력하면 이미 존재하는 경쟁사를 찾아내고, 리뷰에서 나온 강약점과 시장이 갈리는 축을 보여줍니다. 점수는 매기지 않습니다.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="flex min-h-dvh flex-col">
        <SiteHeader />
        <main className="flex-1">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
