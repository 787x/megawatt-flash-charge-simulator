"use client";

import { useEffect, useRef } from "react";
import type { HistorySample } from "../simulation/types";

const powerSeries = [
  { key: "chargingPowerKw" as const, color: "#f6c85f", label: "车辆功率" },
  { key: "gridPowerKw" as const, color: "#54a7ff", label: "电网功率" },
  { key: "storagePowerKw" as const, color: "#52d8a3", label: "储能功率（+放 / −充）" },
];

function prepareCanvas(canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, rect.width * ratio);
  canvas.height = Math.max(1, rect.height * ratio);
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.scale(ratio, ratio);
  context.clearRect(0, 0, rect.width, rect.height);
  return { context, width: rect.width, height: rect.height };
}

function drawGrid(context: CanvasRenderingContext2D, width: number, height: number, color: string) {
  context.strokeStyle = color;
  context.lineWidth = 1;
  for (let index = 0; index <= 4; index += 1) {
    const y = 14 + (height - 30) * index / 4;
    context.beginPath();
    context.moveTo(8, y);
    context.lineTo(width - 8, y);
    context.stroke();
  }
}

export function TrendCanvas({ history, storageCapacityKWh, storageMinSocPercent, currentStorageEnergyKWh, currentStorageSocPercent, sampleIntervalSec }: { history: HistorySample[]; storageCapacityKWh: number; storageMinSocPercent: number; currentStorageEnergyKWh: number; currentStorageSocPercent: number; sampleIntervalSec: number }) {
  const powerRef = useRef<HTMLCanvasElement>(null);
  const energyRef = useRef<HTMLCanvasElement>(null);
  const samples = history.slice(-Math.max(2, Math.ceil(1800 / Math.max(1, sampleIntervalSec))));
  const latest = samples.at(-1);

  useEffect(() => {
    const canvas = powerRef.current;
    if (!canvas) return;
    const prepared = prepareCanvas(canvas);
    if (!prepared) return;
    const { context, width, height } = prepared;
    const styles = getComputedStyle(canvas);
    drawGrid(context, width, height, styles.getPropertyValue("--chart-grid").trim() || "#253745");
    if (samples.length < 2) return;
    const maximum = Math.max(2100, ...samples.flatMap((sample) => [sample.chargingPowerKw, sample.gridPowerKw, Math.abs(sample.storagePowerKw)]));
    const minimum = -Math.max(300, ...samples.map((sample) => Math.max(0, -sample.storagePowerKw)));
    const yFor = (value: number) => 14 + (maximum - value) / (maximum - minimum) * (height - 30);
    context.strokeStyle = styles.getPropertyValue("--chart-axis").trim() || "#5f7680";
    context.setLineDash([4, 4]);
    context.beginPath();
    context.moveTo(8, yFor(0));
    context.lineTo(width - 8, yFor(0));
    context.stroke();
    context.setLineDash([]);
    for (const item of powerSeries) {
      context.strokeStyle = item.color;
      context.lineWidth = item.key === "chargingPowerKw" ? 2.6 : 2;
      context.beginPath();
      samples.forEach((sample, index) => {
        const x = 8 + index / (samples.length - 1) * (width - 16);
        const y = yFor(Number(sample[item.key]));
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.stroke();
    }
  }, [samples]);

  useEffect(() => {
    const canvas = energyRef.current;
    if (!canvas) return;
    const prepared = prepareCanvas(canvas);
    if (!prepared) return;
    const { context, width, height } = prepared;
    const styles = getComputedStyle(canvas);
    drawGrid(context, width, height, styles.getPropertyValue("--chart-grid").trim() || "#253745");
    if (samples.length < 2) return;
    const yFor = (value: number) => 14 + (1 - Math.max(0, Math.min(1, value / Math.max(1, storageCapacityKWh)))) * (height - 30);
    const minimumEnergy = storageCapacityKWh * storageMinSocPercent / 100;
    context.strokeStyle = "#f6c85f";
    context.setLineDash([5, 5]);
    context.beginPath();
    context.moveTo(8, yFor(minimumEnergy));
    context.lineTo(width - 8, yFor(minimumEnergy));
    context.stroke();
    context.setLineDash([]);
    const gradient = context.createLinearGradient(0, 12, 0, height);
    gradient.addColorStop(0, "rgba(82, 216, 163, .38)");
    gradient.addColorStop(1, "rgba(82, 216, 163, .02)");
    context.beginPath();
    samples.forEach((sample, index) => {
      const x = 8 + index / (samples.length - 1) * (width - 16);
      const y = yFor(sample.storageEnergyKWh ?? sample.storageSocPercent * storageCapacityKWh / 100);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.lineTo(width - 8, height - 16);
    context.lineTo(8, height - 16);
    context.closePath();
    context.fillStyle = gradient;
    context.fill();
    context.beginPath();
    samples.forEach((sample, index) => {
      const x = 8 + index / (samples.length - 1) * (width - 16);
      const y = yFor(sample.storageEnergyKWh ?? sample.storageSocPercent * storageCapacityKWh / 100);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.strokeStyle = "#52d8a3";
    context.lineWidth = 2.5;
    context.stroke();
  }, [samples, storageCapacityKWh, storageMinSocPercent]);

  return (
    <div className="trend-dashboard">
      <article className="trend-card power-trend-card">
        <div className="trend-card-head"><div><span>POWER FLOW</span><strong>电网—储能—车辆功率</strong></div><b>{Math.round(latest?.chargingPowerKw ?? 0).toLocaleString("zh-CN")} kW</b></div>
        <canvas ref={powerRef} className="trend-canvas" aria-label="最近 30 分钟电网、储能与车辆充电功率趋势" />
        <div className="chart-legend">{powerSeries.map((item) => <span key={item.key}><i style={{ background: item.color }} />{item.label}</span>)}</div>
      </article>
      <article className="trend-card energy-trend-card">
        <div className="trend-card-head"><div><span>STORAGE ENERGY</span><strong>闪充站储能电量</strong></div><b>{(latest?.storageEnergyKWh ?? currentStorageEnergyKWh).toFixed(1)} kWh</b></div>
        <canvas ref={energyRef} className="trend-canvas" aria-label="最近 30 分钟闪充站储能电量趋势" />
        <div className="energy-caption"><span>安全下限 {Math.round(storageCapacityKWh * storageMinSocPercent / 100)} kWh</span><strong>{(latest?.storageSocPercent ?? currentStorageSocPercent).toFixed(1)}% SOC</strong><span>额定 {storageCapacityKWh} kWh</span></div>
      </article>
    </div>
  );
}
