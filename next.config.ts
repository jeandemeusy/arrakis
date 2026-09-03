import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits .next/standalone with a self-contained server and only the traced
  // dependencies, which is what the container image ships.
  output: "standalone",
};

export default nextConfig;
