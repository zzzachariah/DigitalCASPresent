/** @type {import('next').NextConfig} */
const nextConfig = {
  // pdf-parse / mammoth are server-only; keep them external to the bundle.
  experimental: {
    serverComponentsExternalPackages: ["pdf-parse", "mammoth"],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), geolocation=(), payment=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
