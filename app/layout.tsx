import type { Metadata, Viewport } from "next";
import { DeepPilotProvider } from "@/components/deep-pilot-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "DeepPilot",
  description: "Sui AI intent trading terminal for guarded DeepBook execution."
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
