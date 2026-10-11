import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 画面は Desktop と共通の @aether/ui (TypeScript ソースのまま配布) を使う
  transpilePackages: ["@aether/ui"],
  allowedDevOrigins: ["b2ef-182-166-234-46.ngrok-free.app"],
};

export default nextConfig;
