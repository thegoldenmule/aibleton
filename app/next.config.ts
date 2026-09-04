import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@aibleton/protocol"],
  // The dev tools indicator sat on top of the command bar even after repositioning; drop it.
  devIndicators: false,
};

export default nextConfig;
