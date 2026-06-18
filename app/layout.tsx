import type { Metadata, Viewport } from "next";
import { DeepPilotProvider } from "@/components/deep-pilot-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "DeepPilot",
  description: "Sui AI intent trading terminal for guarded DeepBook execution.",
  icons: {
    icon: [
      { url: "/deeppilot-mark.svg", type: "image/svg+xml" },
      { url: "/icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" }
    ],
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }]
  }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#050607"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <DeepPilotProvider>{children}</DeepPilotProvider>
      </body>
    </html>
  );
}
