import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@aibleton/protocol"],
  // Default bottom-left sits on top of the command bar; move it out of the way.
  devIndicators: {
    position: "top-right",
  },
};

export default nextConfig;
