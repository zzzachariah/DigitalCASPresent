/** @type {import('next').NextConfig} */
const nextConfig = {
  // pdf-parse / mammoth are server-only; keep them external to the bundle.
  experimental: {
    serverComponentsExternalPackages: ["pdf-parse", "mammoth"],
  },
};

export default nextConfig;
