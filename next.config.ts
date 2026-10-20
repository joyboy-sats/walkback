import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@mysten-incubation/memwal", "postgres"],
};

export default nextConfig;
