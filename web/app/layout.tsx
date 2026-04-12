import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Executable Contracts — pipeline viewer",
  description: "Markdown → IR → scenario → execution → regenerated English",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
