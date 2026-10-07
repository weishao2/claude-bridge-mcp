export const metadata = {
  title: "Claude Bridge MCP",
  description: "Private text-only MCP bridge for Claude"
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
