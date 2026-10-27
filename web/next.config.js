/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Lets routes import the pure worker validator via the @shared/* alias (see tsconfig.json).
    externalDir: true,
  },
};

module.exports = nextConfig;
