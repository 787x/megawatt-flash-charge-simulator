"use client";

import { useEffect, useRef, useState } from "react";
import type { HistorySample } from "../simulation/types";

const powerSeries = [
  { key: "chargingPowerKw" as const, color: "#f6c85f", dash: [] as number[], legendClass: "solid", label: "车辆功率" },
  { key: "gridPowerKw" as const, color: "#54a7ff", dash: [8, 4], legendClass: "dashed", label: "电网功率" },
  { key: "storagePowerKw" as const, color: "#52d8a3", dash: [2, 4], legendClass: "dotted", label: "储能功率（+放 / −充）" },
];

const chartInsets = { top: 8, right: 8, bottom: 24, left: 42 };

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

function niceStep(range: number, targetIntervals = 5) {
  const roughStep = Math.max(1, range / targetIntervals);
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

function powerScale(samples: HistorySample[]) {
  const maximum = Math.max(2100, ...samples.flatMap((sample) => [sample.chargingPowerKw, sample.gridPowerKw, Math.abs(sample.storagePowerKw)]));
  const minimum = -Math.max(300, ...samples.map((sample) => Math.max(0, -sample.storagePowerKw)));
  const step = niceStep(maximum - minimum);
  const scaleMinimum = Math.floor(minimum / step) * step;
  const scaleMaximum = Math.ceil(maximum / step) * step;
  const ticks: number[] = [];
  for (let value = scaleMinimum; value <= scaleMaximum + step / 2; value += step) ticks.push(value);
  return { minimum: scaleMinimum, maximum: scaleMaximum, ticks };
}

function formatAxisValue(value: number) {
  return Math.round(value).toLocaleString("zh-CN");
}

function formatTimeAxis(timeSec: number) {
  const safe = Math.max(0, Math.round(timeSec));
  const hours = Math.floor(safe / 3600).toString().padStart(2, "0");
  const minutes = Math.floor((safe % 3600) / 60).toString().padStart(2, "0");
  const seconds = (safe % 60).toString().padStart(2, "0");
  return `T+${hours}:${minutes}:${seconds}`;
}

function setAxisTextStyle(context: CanvasRenderingContext2D, color: string) {
  context.fillStyle = color;
  context.font = '10px Consolas, "SFMono-Regular", monospace';
  context.textBaseline = "middle";
}

function drawTimeAxis(context: CanvasRenderingContext2D, samples: HistorySample[], width: number, height: number, color: string) {
  if (samples.length === 0) return;
  const firstTime = samples[0].timeSec;
  const lastTime = samples.at(-1)?.timeSec ?? firstTime;
  const axisY = height - 7;
  setAxisTextStyle(context, color);

  if (firstTime === lastTime) {
    context.textAlign = "right";
    context.fillText(formatTimeAxis(lastTime), width - chartInsets.right, axisY);
    return;
  }

  const labels = [
    { time: firstTime, x: chartInsets.left, align: "left" as CanvasTextAlign },
    ...(samples.length > 2 ? [{ time: Math.round((firstTime + lastTime) / 2), x: (chartInsets.left + width - chartInsets.right) / 2, align: "center" as CanvasTextAlign }] : []),
    { time: lastTime, x: width - chartInsets.right, align: "right" as CanvasTextAlign },
  ];
  for (const label of labels) {
    context.textAlign = label.align;
    context.fillText(formatTimeAxis(label.time), label.x, axisY);
  }
}

export function TrendCanvas({ history, storageCapacityKWh, storageMinSocPercent, currentStorageEnergyKWh, currentStorageSocPercent, sampleIntervalSec }: { history: HistorySample[]; storageCapacityKWh: number; storageMinSocPercent: number; currentStorageEnergyKWh: number; currentStorageSocPercent: number; sampleIntervalSec: number }) {
  const powerRef = useRef<HTMLCanvasElement>(null);
  const energyRef = useRef<HTMLCanvasElement>(null);
  const [resizeVersion, setResizeVersion] = useState(0);
  const samples = history.slice(-Math.max(2, Math.ceil(1800 / Math.max(1, sampleIntervalSec))));
  const latest = samples.at(-1);

  useEffect(() => {
    let frame = 0;
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => setResizeVersion((version) => version + 1));
    });
    if (powerRef.current) observer.observe(powerRef.current);
    if (energyRef.current) observer.observe(energyRef.current);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const canvas = powerRef.current;
    if (!canvas) return;
    const prepared = prepareCanvas(canvas);
    if (!prepared) return;
    const { context, width, height } = prepared;
    const styles = getComputedStyle(canvas);
    const gridColor = styles.getPropertyValue("--chart-grid").trim() || "#253745";
    const axisColor = styles.getPropertyValue("--chart-axis").trim() || "#5f7680";
    const plotRight = width - chartInsets.right;
    const plotBottom = height - chartInsets.bottom;
    const { minimum, maximum, ticks } = powerScale(samples);
    const yFor = (value: number) => chartInsets.top + (maximum - value) / (maximum - minimum) * (plotBottom - chartInsets.top);
    const firstTime = samples[0]?.timeSec ?? 0;
    const lastTime = samples.at(-1)?.timeSec ?? firstTime;
    const xFor = (timeSec: number) => lastTime === firstTime ? plotRight : chartInsets.left + (timeSec - firstTime) / (lastTime - firstTime) * (plotRight - chartInsets.left);

    setAxisTextStyle(context, axisColor);
    for (const tick of ticks) {
      const y = yFor(tick);
      context.strokeStyle = tick === 0 ? axisColor : gridColor;
      context.lineWidth = 1;
      context.setLineDash(tick === 0 ? [4, 4] : []);
      context.beginPath();
      context.moveTo(chartInsets.left, y);
      context.lineTo(plotRight, y);
      context.stroke();
      context.textAlign = "right";
      context.fillText(formatAxisValue(tick), chartInsets.left - 6, y);
    }
    context.setLineDash([]);

    if (minimum <= 0 && maximum >= 0) {
      const zeroY = yFor(0);
      context.textAlign = "right";
      context.fillText("+放 / −充", plotRight - 2, Math.max(chartInsets.top + 6, zeroY - 7));
    }
    drawTimeAxis(context, samples, width, height, axisColor);

    if (samples.length === 0) return;
    for (const item of powerSeries) {
      context.strokeStyle = item.color;
      context.fillStyle = item.color;
      context.lineWidth = item.key === "chargingPowerKw" ? 2.6 : 2;
      context.lineCap = item.key === "storagePowerKw" ? "round" : "butt";
      context.setLineDash(item.dash);
      context.beginPath();
      samples.forEach((sample, index) => {
        const x = xFor(sample.timeSec);
        const y = yFor(Number(sample[item.key]));
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.stroke();
      if (samples.length === 1) {
        const sample = samples[0];
        context.setLineDash([]);
        context.beginPath();
        context.arc(xFor(sample.timeSec), yFor(Number(sample[item.key])), 2.5, 0, Math.PI * 2);
        context.fill();
      }
    }
    context.setLineDash([]);
    context.lineCap = "butt";
  }, [samples, resizeVersion]);

  useEffect(() => {
    const canvas = energyRef.current;
    if (!canvas) return;
    const prepared = prepareCanvas(canvas);
    if (!prepared) return;
    const { context, width, height } = prepared;
    const styles = getComputedStyle(canvas);
    const gridColor = styles.getPropertyValue("--chart-grid").trim() || "#253745";
    const axisColor = styles.getPropertyValue("--chart-axis").trim() || "#5f7680";
    const plotRight = width - chartInsets.right;
    const plotBottom = height - chartInsets.bottom;
    const yFor = (value: number) => chartInsets.top + (1 - Math.max(0, Math.min(1, value / Math.max(1, storageCapacityKWh)))) * (plotBottom - chartInsets.top);
    const firstTime = samples[0]?.timeSec ?? 0;
    const lastTime = samples.at(-1)?.timeSec ?? firstTime;
    const xFor = (timeSec: number) => lastTime === firstTime ? plotRight : chartInsets.left + (timeSec - firstTime) / (lastTime - firstTime) * (plotRight - chartInsets.left);
    const energyTicks = [storageCapacityKWh, storageCapacityKWh / 2, 0];

    setAxisTextStyle(context, axisColor);
    for (const tick of energyTicks) {
      const y = yFor(tick);
      context.strokeStyle = gridColor;
      context.lineWidth = 1;
      context.setLineDash([]);
      context.beginPath();
      context.moveTo(chartInsets.left, y);
      context.lineTo(plotRight, y);
      context.stroke();
      context.textAlign = "right";
      context.fillText(formatAxisValue(tick), chartInsets.left - 6, y);
    }
    drawTimeAxis(context, samples, width, height, axisColor);

    const minimumEnergy = storageCapacityKWh * storageMinSocPercent / 100;
    const minimumY = yFor(minimumEnergy);
    context.strokeStyle = "#f6c85f";
    context.setLineDash([5, 5]);
    context.beginPath();
    context.moveTo(chartInsets.left, minimumY);
    context.lineTo(plotRight, minimumY);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = "#f6c85f";
    context.font = '10px Inter, "Segoe UI", sans-serif';
    context.textAlign = "right";
    context.textBaseline = "bottom";
    context.fillText(`下限 ${Math.round(minimumEnergy)}`, plotRight - 2, minimumY - 3);

    if (samples.length === 0) return;
    context.beginPath();
    samples.forEach((sample, index) => {
      const x = xFor(sample.timeSec);
      const y = yFor(sample.storageEnergyKWh ?? sample.storageSocPercent * storageCapacityKWh / 100);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.strokeStyle = "#52d8a3";
    context.lineWidth = 2.5;
    context.stroke();
    if (samples.length === 1) {
      const sample = samples[0];
      context.fillStyle = "#52d8a3";
      context.beginPath();
      context.arc(xFor(sample.timeSec), yFor(sample.storageEnergyKWh ?? sample.storageSocPercent * storageCapacityKWh / 100), 2.5, 0, Math.PI * 2);
      context.fill();
    }
  }, [samples, storageCapacityKWh, storageMinSocPercent, resizeVersion]);

  return (
    <div className="trend-dashboard">
      <article className="trend-card power-trend-card">
        <div className="trend-card-head"><div><span>POWER FLOW</span><strong>电网—储能—车辆功率 <small>kW</small></strong></div><b>{Math.round(latest?.chargingPowerKw ?? 0).toLocaleString("zh-CN")} kW</b></div>
        <canvas ref={powerRef} className="trend-canvas" aria-label="最多最近 30 分钟电网、储能与车辆充电功率趋势，纵轴单位 kW，横轴为真实仿真时间" />
        <div className="chart-legend">{powerSeries.map((item) => <span key={item.key}><i className={item.legendClass} style={{ borderColor: item.color }} />{item.label}</span>)}</div>
      </article>
      <article className="trend-card energy-trend-card">
        <div className="trend-card-head"><div><span>STORAGE ENERGY</span><strong>闪充站储能电量 <small>kWh</small></strong></div><b>{(latest?.storageEnergyKWh ?? currentStorageEnergyKWh).toFixed(1)} kWh</b></div>
        <canvas ref={energyRef} className="trend-canvas" aria-label="最多最近 30 分钟闪充站储能电量趋势，纵轴单位 kWh，横轴为真实仿真时间" />
        <div className="energy-caption"><span>安全下限 {Math.round(storageCapacityKWh * storageMinSocPercent / 100)} kWh</span><strong>{(latest?.storageSocPercent ?? currentStorageSocPercent).toFixed(1)}% SOC</strong><span>额定 {storageCapacityKWh} kWh</span></div>
      </article>
    </div>
  );
}
