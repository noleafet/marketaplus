import type { Metadata } from "next";
import "@/styles/globals.css";
import "@/styles/chart.css";
import "@/styles/responsive.css";
import "@/styles/report.css";
import "@/styles/shadcn.css";
import "@/styles/tailwind.css";

export const metadata: Metadata = {
  title: "Marketa+ - Market Analysis & Alerts",
  description: "Market analysis, chart alerts, and persistent monitoring.",
};

/**
 * Applies the saved theme before the first paint so dark mode never flashes the
 * light palette while React hydrates.
 */
const themeScript = `
try {
  var theme = localStorage.getItem('tradechart.theme');
  var dark = theme === 'dark';
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
} catch (error) {}
`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-svh bg-background font-sans antialiased">
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        {children}
      </body>
    </html>
  );
}
