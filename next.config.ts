import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [new URL("https://m.media-amazon.com/**")],
  },
};

export default nextConfig;
