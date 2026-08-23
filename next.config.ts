import type { NextConfig } from "next";

const config: NextConfig = {
  // 파이프라인은 Node 전용 SDK(Anthropic·OpenAI)를 쓰므로 서버에서만 돌아야 한다.
  serverExternalPackages: ["@anthropic-ai/sdk", "openai"],
};

export default config;
