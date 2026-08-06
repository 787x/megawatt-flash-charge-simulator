import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "兆瓦闪充站运营模拟器",
    template: "%s · 兆瓦闪充站运营模拟器",
  },
  description: "模拟 A 通用枪、B 闪充专用枪、2100kW 整桩共享限制、电网与储能协同运行。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  openGraph: {
    type: "website",
    title: "兆瓦闪充站运营模拟器",
    description: "看见车辆兼容、排队公平与兆瓦功率共享如何共同塑造站点吞吐。",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "兆瓦闪充站运营模拟器运营驾驶舱" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "兆瓦闪充站运营模拟器",
    description: "双枪角色感知调度与储能削峰交互研究工具",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b1118",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" data-theme="dark" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
