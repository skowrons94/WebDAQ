import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster"
import { ThemeProvider } from "@/components/theme-provider"
import Script from "next/script";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "LUNA Control Panel",
  description: "Created by J. Skowronski, A. Compagnucci and R. Gesue",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <Script
          src="https://root.cern/js/latest/scripts/JSRoot.core.js"
          crossOrigin='anonymous'
        />
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >        
        {children}
          <Toaster />

        </ThemeProvider>
      </body>
    </html>
  );
}
