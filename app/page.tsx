import type { Metadata } from "next";
import { Dashboard } from "./components/Dashboard";

export const metadata: Metadata = {
  title: { absolute: "兆瓦闪充站运营模拟器" },
  description: "带车辆兼容约束、双枪功率共享、储能削峰与队列诊断的交互式闪充站运营研究工具。",
};

export default function Home() {
  return <Dashboard />;
}
