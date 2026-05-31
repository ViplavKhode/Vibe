import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "inngest",
    "@inngest/agent-kit",
    "@inngest/ai",
  ],
};

export default nextConfig;
