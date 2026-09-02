/** @type {import('next').NextConfig} */
const nextConfig = {
  agentRules: false,
  serverExternalPackages: ["sql.js"],
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
