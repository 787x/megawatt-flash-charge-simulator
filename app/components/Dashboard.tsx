"use client";

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { TrendCanvas } from "./TrendCanvas";
import {
  addManualVehicle,
  createEmptyState,
  createInitialState,
  estimateRemainingChargeTime,
  estimateVehicleWaitTime,
  getEffectiveGridLimit,
  getGridAvailableCapacityUtilizationPercent,
  getGridRatedCapacityUtilizationPercent,
  setGridControl,
  setStorageEnergy,
  stepSimulation,
} from "../simulation/engine";
import { baseConfig, flashCurve, scenarioPresets, standardCurve } from "../simulation/presets";
import type {
  ChargingCurvePoint,
  Connector,
  SimulationConfig,
  SimulationConfigV3,
  SimulationState,
  Vehicle,
  VehicleChargingClass,
  VehicleModel,
  PowerLimitReason,
} from "../simulation/types";
import { normalizeSimulationConfig, cloneConfigV3, getScenarioConfigV3, parseSimulationConfig } from "../simulation/config-persistence";
import { cloneChargingCurve, DEFAULT_FLASH_MODEL_ID, DEFAULT_STANDARD_MODEL_ID, DEFAULT_FLASH_CAPACITY_KWH, DEFAULT_STANDARD_CAPACITY_KWH, cloneDefaultChargingCurve, createVehicleModel as createVehicleModelHelper, renameVehicleModel as renameVehicleModelHelper, canChangeModelClass, changeModelClass, restoreDefaultCurve as restoreDefaultCurveHelper, isModelNameValid, isModelNameUnique, CAPACITY_MIN_KWH, CAPACITY_MAX_KWH, resolveVehicleModelId, isDefaultVehicleModel, canDeleteVehicleModel, deleteVehicleModel as deleteVehicleModelHelper } from "../simulation/vehicle-models";

const speedOptions = [1, 5, 10, 30, 60, 120, 300];
const sampleOptions = [1, 5, 10, 30, 60];
const minimumQueuePreview = 6;
const queueCellMinWidth = 92;
const tabs = [
  { name: "车辆", kind: "live" },
  { name: "事件", kind: "live" },
  { name: "运营结果", kind: "result" },
  { name: "模型 · 车型与曲线", kind: "model" },
  { name: "参考 · 参数来源", kind: "reference" },
] as const;
type Tab = typeof tabs[number]["name"];
type MobileView = "station" | "control" | "analysis";
type MobileAnalysisView = "trend" | "vehicles" | "events" | "results" | "model" | "reference";

const statusNames: Record<Vehicle["status"], string> = {
  scheduled: "即将到达",
  arriving: "驶入中",
  queued: "排队",
  moving_to_bay: "进位",
  connecting: "握手",
  charging: "充电中",
  completed: "已完成",
  disconnecting: "拔枪结算",
  departing: "离场",
  departed: "已离场",
  abandoned: "弃队",
  faulted: "故障",
};

const policyNames: Record<SimulationConfig["pilePolicy"], string> = {
  dedicated_first: "闪充专枪优先",
  equal_max_min: "公平分配",
  proportional_to_request: "按请求比例",
  universal_first: "通用枪优先",
  custom_weighted: "自定义权重",
};

const queuePolicyNames: Record<SimulationConfig["queuePolicy"], string> = {
  role_aware_fcfs: "角色感知 FCFS",
  standard_priority_on_universal: "通用枪普通车优先",
  flash_priority: "闪充车辆优先",
  shortest_expected_session: "最短会话优先",
  lowest_soc_first: "低 SOC 优先",
  weighted_wait_time: "加权等待时间",
};

const limitReasonNames: Record<PowerLimitReason, string> = {
  none: "无",
  vehicle_curve: "车辆充电曲线",
  vehicle_max_power: "车辆功率上限",
  connector_max_power: "枪口功率上限",
  connector_policy_cap: "枪口策略上限",
  pile_aggregate_limit: "整桩共享上限",
  pile_allocation_policy: "桩内分配策略",
  station_power_limit: "站级可用功率",
  grid_power_limit: "电网功率上限",
  storage_discharge_limit: "储能放电能力",
  storage_soc_floor: "储能最低 SOC",
};

function formatPower(value: number) {
  return `${Math.round(value).toLocaleString("zh-CN")}\u00A0kW`;
}

function formatEnergy(value: number) {
  return value.toLocaleString("zh-CN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function formatTime(seconds: number) {
  const value = Math.max(0, Math.round(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`;
}

function vehicleWaitDuration(vehicle: Vehicle, timeSec: number) {
  const start = vehicle.queuedAtSec ?? vehicle.arrivalTimeSec;
  return Math.max(0, (vehicle.chargingStartedAtSec ?? timeSec) - start);
}

function vehicleChargeDuration(vehicle: Vehicle, timeSec: number) {
  if (vehicle.chargingStartedAtSec === undefined) return 0;
  return Math.max(0, (vehicle.completedAtSec ?? timeSec) - vehicle.chargingStartedAtSec);
}

function download(name: string, content: string, type = "text/plain") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function VehicleGlyph({ vehicle, compact = false, onClick }: { vehicle: Vehicle; compact?: boolean; onClick?: () => void }) {
  return (
    <button
      className={`vehicle-glyph ${vehicle.chargingClass === "flash_capable" ? "flash" : "standard"} ${compact ? "compact" : ""}`}
      onClick={onClick}
      aria-label={`查看 ${vehicle.id} 详情`}
      title={`${vehicle.id} · ${vehicle.name} · ${vehicle.chargingClass === "flash_capable" ? "闪充" : "普通"}`}
    >
      <span className="vehicle-window" />
      <span className="vehicle-id">{vehicle.id}</span>
      {!compact && <span className="vehicle-soc">{Math.round(vehicle.currentSocPercent)}%</span>}
    </button>
  );
}

function ConnectorBay({ connector, state, config, onVehicle }: { connector: Connector; state: SimulationState; config: SimulationConfigV3; onVehicle: (vehicle: Vehicle) => void }) {
  const vehicle = state.vehicles.find((item) => item.id === connector.currentVehicleId);
  const isTurnover = !vehicle && connector.turnoverRemainingSec > 0;
  const standardWaiting = state.queue.filter((id) => state.vehicles.find((item) => item.id === id)?.chargingClass === "standard_dc").length;
  const flashWaiting = state.queue.length - standardWaiting;
  const isIncompatibleIdle = connector.role === "flash_dedicated" && !vehicle && !isTurnover && standardWaiting > 0 && flashWaiting === 0;
  const isLimited = connector.requestedPowerKw > connector.actualPowerKw + 1;
  const remainingChargeSec = vehicle ? estimateRemainingChargeTime(vehicle) : 0;
  const limitLabels = vehicle?.limitReasons.filter((reason) => reason !== "none").map((reason) => limitReasonNames[reason]) ?? [];
  const roleName = connector.role === "universal" ? "通用枪" : "闪充专用枪";
  const eligibility = connector.role === "universal" ? "闪充兼容 / 普通直流" : "仅闪充兼容车辆";
  return (
    <article className={`connector-bay ${connector.role} ${isIncompatibleIdle ? "incompatible" : ""} ${isTurnover ? "turnover" : ""} ${isLimited ? "limited" : ""}`}>
      <div className="connector-head">
        <div>
          <span className="connector-letter">{connector.role === "universal" ? "A" : "B"}</span>
          <span className="connector-identity"><strong>{roleName}</strong><small>{eligibility}</small></span>
        </div>
        <span className={`state-dot ${isLimited ? "warn" : vehicle ? "busy" : isTurnover || isIncompatibleIdle ? "warn" : "idle"}`}>
          {vehicle ? statusNames[vehicle.status] : isTurnover ? "换车中" : isIncompatibleIdle ? "不兼容空闲" : "空闲"}
        </span>
      </div>
      <div className="connector-power-grid">
        <div className="primary-reading"><span>实际功率</span><strong>{Math.round(connector.actualPowerKw).toLocaleString("zh-CN")}<small>kW</small></strong></div>
        <div><span>请求功率</span><strong>{Math.round(connector.requestedPowerKw).toLocaleString("zh-CN")}<small>kW</small></strong></div>
      </div>
      {vehicle ? <>
        <div className="vehicle-session">
          <VehicleGlyph vehicle={vehicle} onClick={() => onVehicle(vehicle)} />
          <div className="vehicle-session-data">
            <div className="vehicle-session-head"><div><strong>{vehicle.id}</strong><span className="vehicle-session-model" title={vehicle.name}>{vehicle.name}</span><small>{vehicle.chargingClass === "flash_capable" ? "闪充" : "普通"}</small></div><small>{statusNames[vehicle.status]}</small></div>
            <div className="connector-soc"><div><span>SOC</span><strong>{vehicle.currentSocPercent.toFixed(1)}%</strong><small>目标 {vehicle.targetSocPercent}%</small></div><i><em style={{ width: `${Math.min(100, vehicle.currentSocPercent)}%` }} /><b style={{ left: `${Math.min(100, vehicle.targetSocPercent)}%` }} /></i></div>
            <div className="session-eta"><span>预计剩余</span><strong>{remainingChargeSec > 0 ? formatDuration(remainingChargeSec) : "—"}</strong></div>
          </div>
        </div>
        <div className="mobile-connector-readings" aria-label={`${vehicle.id} 当前充电数据`}>
          <span><small>实际功率</small><strong>{Math.round(connector.actualPowerKw).toLocaleString("zh-CN")}<em>kW</em></strong><i>请求 {Math.round(connector.requestedPowerKw).toLocaleString("zh-CN")} kW</i></span>
          <span><small>SOC</small><strong>{vehicle.currentSocPercent.toFixed(1)}<em>%</em></strong><i>目标 {vehicle.targetSocPercent}%</i></span>
          <span><small>预计剩余</small><strong>{remainingChargeSec > 0 ? formatDuration(remainingChargeSec) : "—"}</strong></span>
        </div>
      </> : <div className="connector-empty"><strong>{isTurnover ? `车位周转 ${formatDuration(connector.turnoverRemainingSec)}` : isIncompatibleIdle ? "枪口可用，但无兼容车辆" : "暂无接入车辆"}</strong><span>{isTurnover ? `周转完成后继续调度 · 默认 ${formatDuration(config.turnoverSec)}` : isIncompatibleIdle ? `${standardWaiting} 辆普通直流车辆仅可使用 A 通用枪` : "等待调度兼容车辆"}</span></div>}
      {vehicle?.chargingClass === "flash_capable" && connector.role === "universal" && <p className="connector-note">闪充兼容车当前使用 A 通用枪</p>}
      {isLimited && <p className="connector-note warning"><strong>功率受限</strong><span>{limitLabels.length ? limitLabels.join(" · ") : "实际功率低于请求功率"}</span></p>}
      {isIncompatibleIdle && <p className="connector-note warning"><strong>B 枪空闲</strong><span>等待车辆与专用枪不兼容</span></p>}
    </article>
  );
}

function ParameterRow({ label, value, min, max, step = 1, unit, onChange, showSlider = true }: { label: string; value: number; min: number; max: number; step?: number; unit: string; onChange: (value: number) => void; showSlider?: boolean }) {
  const [draft, setDraft] = useState(String(value));
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setDraft(String(value));
    setInvalid(false);
  }, [value]);

  const updateFromText = (raw: string) => {
    setDraft(raw);
    const next = Number(raw);
    const isValid = raw.trim() !== "" && Number.isFinite(next) && next >= min && next <= max;
    setInvalid(!isValid);
    if (isValid) onChange(next);
  };

  const restoreValue = () => {
    if (!invalid) return;
    setDraft(String(value));
    setInvalid(false);
  };

  const updateFromSlider = (raw: number) => {
    const snapped = Math.round(raw / step) * step;
    onChange(Math.max(min, Math.min(max, snapped)));
  };

  return (
    <div className={`parameter-row ${showSlider ? "with-slider" : "number-only"}`}>
      <label>
        <span>{label}</span>
        <span className={`parameter-value ${invalid ? "invalid" : ""}`}>
          <input
            type="number"
            value={draft}
            min={min}
            max={max}
            step={step}
            inputMode="decimal"
            aria-invalid={invalid}
            aria-label={`${label}，${unit}`}
            onChange={(event) => updateFromText(event.target.value)}
            onBlur={restoreValue}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setDraft(String(value));
                setInvalid(false);
                event.currentTarget.blur();
              }
            }}
          />
          <small>{unit}</small>
        </span>
      </label>
      {showSlider && <input aria-label={`${label}快速调整`} type="range" value={value} min={min} max={max} step="any" onChange={(event) => updateFromSlider(Number(event.target.value))} onKeyDown={(event) => {
        if (["ArrowLeft", "ArrowDown", "ArrowRight", "ArrowUp"].includes(event.key)) {
          event.preventDefault();
          updateFromSlider(value + (["ArrowLeft", "ArrowDown"].includes(event.key) ? -step : step));
        }
      }} />}
    </div>
  );
}

function MetricCard({ label, value, note, accent }: { label: string; value: string; note: string; accent?: "blue" | "green" | "amber" | "red" }) {
  return (
    <article className={`metric-card ${accent ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  );
}

function MobileVehicleList({ state, config, onVehicle }: { state: SimulationState; config: SimulationConfigV3; onVehicle: (vehicle: Vehicle) => void }) {
  const vehicles = state.vehicles.slice(-50).reverse();
  if (vehicles.length === 0) return <p className="mobile-analysis-empty">暂无车辆数据</p>;
  return (
    <div className="mobile-vehicle-list" aria-label="移动车辆列表">
      {vehicles.map((vehicle) => {
        const isQueued = vehicle.status === "queued";
        const isActive = ["moving_to_bay", "connecting", "charging"].includes(vehicle.status);
        const remaining = isQueued ? estimateVehicleWaitTime(vehicle.id, state, config).expectedWaitSec : isActive ? estimateRemainingChargeTime(vehicle) : 0;
        const connectorLabel = vehicle.assignedConnectorId ?? (vehicle.chargingClass === "flash_capable" ? "A / B" : "仅 A");
        return (
          <button type="button" className="mobile-vehicle-row" key={vehicle.id} onClick={() => onVehicle(vehicle)} title={`${vehicle.id} · ${vehicle.name}`}>
            <span className="mobile-vehicle-head"><strong>{vehicle.id}</strong><i className={`table-status ${vehicle.status}`}>{statusNames[vehicle.status]}</i><em>{connectorLabel}</em></span>
            <span className="mobile-vehicle-model"><b>{vehicle.name}</b><small>{vehicle.chargingClass === "flash_capable" ? "闪充" : "普通"}</small></span>
            <span className="mobile-vehicle-readings">
              <span><small>SOC</small><strong>{vehicle.currentSocPercent.toFixed(1)}%</strong></span>
              <span><small>{isQueued ? "已等待" : "当前功率"}</small><strong>{isQueued ? formatDuration(vehicleWaitDuration(vehicle, state.timeSec)) : `${Math.round(vehicle.actualPowerKw).toLocaleString("zh-CN")} kW`}</strong></span>
              <span><small>{isQueued ? "预计等待" : isActive ? "预计剩余" : "已充电量"}</small><strong>{remaining > 0 ? formatDuration(remaining) : `${vehicle.deliveredEnergyKWh.toFixed(1)} kWh`}</strong></span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function GridUtilizationRow({ label, accessibleLabel, percent, importEnergyKWh, capacityEnergyKWh, capacityLabel, secondary = false }: { label: string; accessibleLabel: string; percent: number | null; importEnergyKWh: number; capacityEnergyKWh: number; capacityLabel: string; secondary?: boolean }) {
  const progress = Math.min(100, Math.max(0, percent ?? 0));
  return (
    <div className={`grid-utilization-row ${secondary ? "secondary" : ""}`} aria-label={accessibleLabel}>
      <div className="grid-utilization-heading"><span>{label}</span><strong>{percent === null ? "—" : `${percent.toFixed(1)}%`}</strong></div>
      <i role="progressbar" aria-label={accessibleLabel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent === null ? undefined : Number(percent.toFixed(1))}><em style={{ width: `${progress}%` }} /></i>
      <small>累计取电 <b>{formatEnergy(importEnergyKWh)} / {formatEnergy(capacityEnergyKWh)} kWh</b><span>· {capacityLabel}</span></small>
    </div>
  );
}

export function Dashboard() {
  const [config, setConfig] = useState<SimulationConfigV3>(() => cloneConfigV3(normalizeSimulationConfig(baseConfig)));
  const [state, setState] = useState<SimulationState>(() => createInitialState(normalizeSimulationConfig(baseConfig)));
  const [running, setRunning] = useState(true);
  const [speed, setSpeed] = useState(10);
  const [tab, setTab] = useState<Tab>("车辆");
  const [mobileView, setMobileView] = useState<MobileView>("station");
  const [mobileAnalysisView, setMobileAnalysisView] = useState<MobileAnalysisView>("trend");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [selectedVehicle, setSelectedVehicle] = useState<Vehicle | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [toast, setToast] = useState("");
  const [selectedVehicleModelId, setSelectedVehicleModelId] = useState<string>(DEFAULT_FLASH_MODEL_ID);
  const [showNewModel, setShowNewModel] = useState(false);
  const [showRenameModel, setShowRenameModel] = useState(false);
  const [showDeleteModel, setShowDeleteModel] = useState(false);
  const [newModelDraft, setNewModelDraft] = useState({ name: "", chargingClass: "flash_capable" as VehicleChargingClass, capacity: 112 });
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState("");
  const [newModelError, setNewModelError] = useState("");
  const [manual, setManual] = useState({ capacity: 112, maxPower: 1500, initialSoc: 20, targetSoc: 80, quantity: 1 });
  const [manualVehicleModelId, setManualVehicleModelId] = useState<string>(DEFAULT_FLASH_MODEL_ID);
  const [gridLimitDraft, setGridLimitDraft] = useState(500);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [queuePreviewLimit, setQueuePreviewLimit] = useState(minimumQueuePreview);
  const [stationCollapsedHeight, setStationCollapsedHeight] = useState(0);
  const importRef = useRef<HTMLInputElement>(null);
  const queueListRef = useRef<HTMLDivElement>(null);
  const stationPanelRef = useRef<HTMLElement>(null);
  const dialogTriggerRef = useRef<HTMLElement | null>(null);
  const previousDialogRef = useRef<string | null>(null);

  const activeDialog = showAdd ? "add-vehicle" : selectedVehicle ? "vehicle-drawer" : showHelp ? "help" : showReset ? "reset" : showNewModel ? "new-model" : showRenameModel ? "rename-model" : showDeleteModel ? "delete-model" : null;

  useEffect(() => {
    const savedTheme = localStorage.getItem("flash-sim-theme");
    const saved = localStorage.getItem("flash-sim-config");
    const timer = window.setTimeout(() => {
      if (savedTheme === "light") setTheme("light");
      if (!saved) return;
      try {
        const parsed = JSON.parse(saved);
        const normalized = normalizeSimulationConfig(parsed);
        setConfig(normalized);
        setState(createInitialState(normalized));
      } catch {
        localStorage.removeItem("flash-sim-config");
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("flash-sim-theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("flash-sim-config", JSON.stringify(config));
  }, [config]);

  useEffect(() => {
    if (!config.vehicleModels.some((m) => m.id === selectedVehicleModelId)) {
      setSelectedVehicleModelId(resolveVehicleModelId(config.vehicleModels));
    }
  }, [config.vehicleModels, selectedVehicleModelId]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setState((current) => stepSimulation(current, config, speed)), 1000);
    return () => window.clearInterval(timer);
  }, [config, running, speed]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (state.queue.length <= queuePreviewLimit) setQueueExpanded(false);
  }, [queuePreviewLimit, state.queue.length]);

  useEffect(() => {
    const list = queueListRef.current;
    if (!list) return;
    const updatePreviewLimit = () => {
      const columnCount = Math.max(minimumQueuePreview + 1, Math.floor(list.clientWidth / queueCellMinWidth));
      setQueuePreviewLimit(columnCount - 1);
    };
    updatePreviewLimit();
    const observer = new ResizeObserver(updatePreviewLimit);
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (queueExpanded) return;
    const panel = stationPanelRef.current;
    if (!panel) return;
    const updateStationHeight = () => {
      const panelStyle = window.getComputedStyle(panel);
      const borderHeight = Number.parseFloat(panelStyle.borderTopWidth) + Number.parseFloat(panelStyle.borderBottomWidth);
      const contentHeight = Array.from(panel.children).reduce((height, child) => height + child.getBoundingClientRect().height, 0);
      setStationCollapsedHeight(Math.ceil(contentHeight + borderHeight));
    };
    updateStationHeight();
    const observer = new ResizeObserver(updateStationHeight);
    Array.from(panel.children).forEach((child) => observer.observe(child));
    return () => observer.disconnect();
  }, [queueExpanded]);

  useEffect(() => {
    if (!activeDialog) return;
    previousDialogRef.current = activeDialog;
    if (!dialogTriggerRef.current) dialogTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const closeActiveDialog = () => {
      if (activeDialog === "add-vehicle") setShowAdd(false);
      if (activeDialog === "vehicle-drawer") setSelectedVehicle(null);
      if (activeDialog === "help") setShowHelp(false);
      if (activeDialog === "reset") setShowReset(false);
      if (activeDialog === "new-model") setShowNewModel(false);
      if (activeDialog === "rename-model") setShowRenameModel(false);
      if (activeDialog === "delete-model") setShowDeleteModel(false);
    };
    const dialog = document.querySelector<HTMLElement>(`[data-dialog-id="${activeDialog}"]`);
    const focusableSelector = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
    const focusTimer = window.setTimeout(() => {
      const initial = dialog?.querySelector<HTMLElement>("[data-initial-focus], [autofocus]") ?? dialog?.querySelector<HTMLElement>(focusableSelector);
      initial?.focus({ preventScroll: true });
    }, 50);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeActiveDialog();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeDialog]);

  useEffect(() => {
    if (activeDialog || !previousDialogRef.current) return;
    const previousDialog = previousDialogRef.current;
    const trigger = dialogTriggerRef.current;
    previousDialogRef.current = null;
    dialogTriggerRef.current = null;
    const focusTimer = window.setTimeout(() => {
      const modelAction = previousDialog === "new-model" ? "新建" : previousDialog === "rename-model" ? "重命名" : previousDialog === "delete-model" ? "删除" : null;
      const modelTrigger = modelAction ? Array.from(document.querySelectorAll<HTMLButtonElement>(".model-actions-row button")).find((button) => button.textContent?.trim() === modelAction) : null;
      (modelTrigger ?? trigger)?.focus({ preventScroll: true });
    }, 50);
    return () => window.clearTimeout(focusTimer);
  }, [activeDialog]);

  const connectors = state.piles.flatMap((pile) => pile.connectors);
  const connectorA = connectors.find((item) => item.role === "universal")!;
  const connectorB = connectors.find((item) => item.role === "flash_dedicated")!;
  const storageSoc = state.storage.energyKWh / state.storage.capacityKWh * 100;
  const effectiveGridLimit = getEffectiveGridLimit(state, config);
  const chargingVehicles = state.vehicles.filter((vehicle) => vehicle.status === "charging");
  const completedVehicles = state.vehicles.filter((vehicle) => ["disconnecting", "departing", "departed"].includes(vehicle.status));
  const flashWaits = state.vehicles.filter((vehicle) => vehicle.chargingClass === "flash_capable" && vehicle.chargingStartedAtSec !== undefined).map((vehicle) => vehicle.chargingStartedAtSec! - (vehicle.queuedAtSec ?? vehicle.arrivalTimeSec));
  const standardWaits = state.vehicles.filter((vehicle) => vehicle.chargingClass === "standard_dc" && vehicle.chargingStartedAtSec !== undefined).map((vehicle) => vehicle.chargingStartedAtSec! - (vehicle.queuedAtSec ?? vehicle.arrivalTimeSec));
  const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const allWaits = [...flashWaits, ...standardWaits];
  const activeLimit = connectors.some((item) => item.requestedPowerKw > item.actualPowerKw + 1);
  const gridStatusLabel = state.gridControl.mode === "outage" ? "电网断电" : state.gridControl.mode === "limited" ? `限功率 ${Math.round(effectiveGridLimit)}kW` : "正常供电";
  const ratedGridUtilizationPercent = getGridRatedCapacityUtilizationPercent(state);
  const availableGridUtilizationPercent = getGridAvailableCapacityUtilizationPercent(state);
  const hasGridDisturbanceOccurred = state.hasGridDisturbanceOccurred ?? false;
  const standardWaiting = state.queue.filter((id) => state.vehicles.find((vehicle) => vehicle.id === id)?.chargingClass === "standard_dc").length;
  const flashWaiting = state.queue.length - standardWaiting;
  const pile = state.piles[0];
  const pileActualPowerKw = connectorA.actualPowerKw + connectorB.actualPowerKw;
  const pileRequestedPowerKw = connectorA.requestedPowerKw + connectorB.requestedPowerKw;
  const busLoadPowerKw = state.chargingPowerKw + config.baseLoadKw;
  const storageFlowPowerKw = Math.abs(state.storage.powerKw);
  const storageFlowDirection = state.storage.powerKw > 0 ? "←" : state.storage.powerKw < 0 ? "→" : "—";
  const storageFlowLabel = state.storage.powerKw > 0 ? "储能送入母线" : state.storage.powerKw < 0 ? "母线向储能充电" : "储能待机";
  const storageStateLabel = state.storage.powerKw > 0 ? "放电" : state.storage.powerKw < 0 ? "充电" : "待机";
  const aConnectorVehicle = state.vehicles.find((vehicle) => vehicle.id === connectorA.currentVehicleId);
  const stationNoticeActive = activeLimit || state.gridControl.mode !== "normal" || (!connectorB.currentVehicleId && connectorB.turnoverRemainingSec <= 0 && standardWaiting > 0 && flashWaiting === 0) || (aConnectorVehicle?.chargingClass === "flash_capable" && standardWaiting > 0);
  const visibleQueueIds = queueExpanded ? state.queue : state.queue.slice(0, queuePreviewLimit);
  const hiddenQueueCount = Math.max(0, state.queue.length - queuePreviewLimit);
  const sourceNote = config.universalPolicyCapKw ? `A 枪启用 ${config.universalPolicyCapKw}kW 案例策略上限` : "A/B 单枪铭牌上限均为 1500kW";

  const updateConfig = <K extends keyof SimulationConfigV3>(key: K, value: SimulationConfigV3[K]) => setConfig((current) => ({ ...current, [key]: value }));
  const updateMaxAcceptableWait = (value: number | null) => {
    updateConfig("maxAcceptableWaitSec", value);
    setState((current) => ({ ...current, vehicles: current.vehicles.map((vehicle) => ({ ...vehicle, maxAcceptableWaitSec: value })) }));
  };

  const selectedVehicleModel = config.vehicleModels.find((m) => m.id === selectedVehicleModelId)
    ?? config.vehicleModels.find((m) => m.id === DEFAULT_FLASH_MODEL_ID)
    ?? config.vehicleModels[0];

  const updateVehicleModel = (modelId: string, updater: (model: VehicleModel) => VehicleModel) => {
    setConfig((current) => ({
      ...current,
      vehicleModels: current.vehicleModels.map((m) => m.id === modelId ? updater(m) : m),
    }));
  };

  const setCurve = (updater: (current: ChargingCurvePoint[]) => ChargingCurvePoint[]) => {
    if (!selectedVehicleModel) return;
    const nextCurve = updater(selectedVehicleModel.chargingCurve).map((point) => ({ ...point }));
    updateVehicleModel(selectedVehicleModel.id, (m) => ({ ...m, chargingCurve: nextCurve }));
  };
  const updateCurvePower = (index: number, powerKw: number) => {
    const nextPower = Math.max(0, Math.min(1500, Math.round(powerKw / 10) * 10));
    setCurve((current) => current.map((point, itemIndex) => itemIndex === index ? { ...point, powerKw: nextPower } : point));
  };
  const updateCurveFromPointer = (index: number, event: ReactPointerEvent<HTMLButtonElement>) => {
    const container = event.currentTarget.parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const plotTop = rect.top + 10;
    const plotBottom = rect.bottom - 20;
    const ratio = Math.max(0, Math.min(1, (plotBottom - event.clientY) / Math.max(1, plotBottom - plotTop)));
    updateCurvePower(index, ratio * 1500);
  };

  const reset = (nextConfig = config) => {
    setState(createEmptyState(nextConfig));
    setRunning(false);
    setShowReset(false);
    setToast("仿真已重置为空站并暂停");
  };

  const selectScenario = (name: string) => {
    const next = getScenarioConfigV3(name, scenarioPresets[name]);
    setConfig(next);
    setSelectedVehicleModelId(resolveVehicleModelId(next.vehicleModels));
    setState(createInitialState(next));
    setRunning(true);
    setToast(`已载入"${name}"场景`);
  };

  const handleCreateModel = () => {
    if (!selectedVehicleModel) return;
    const result = createVehicleModelHelper(newModelDraft.name, newModelDraft.chargingClass, newModelDraft.capacity);
    if (!result.ok) { setNewModelError(result.error); return; }
    setConfig((current) => ({ ...current, vehicleModels: [...current.vehicleModels, result.model] }));
    setSelectedVehicleModelId(result.model.id);
    setShowNewModel(false);
    setNewModelError("");
    setToast(`已创建车型"${result.model.name}"`);
  };

  const handleRenameModel = () => {
    if (!selectedVehicleModel) return;
    const result = renameVehicleModelHelper(config.vehicleModels, selectedVehicleModel.id, renameDraft);
    if (!result.ok) { setRenameError(result.error); return; }
    setConfig((current) => ({ ...current, vehicleModels: result.models }));
    setShowRenameModel(false);
    setRenameError("");
    setToast("车型已重命名");
  };

  const handleChangeClass = (newClass: VehicleChargingClass) => {
    if (!selectedVehicleModel) return;
    if (!canChangeModelClass(config.vehicleModels, selectedVehicleModel.id, newClass)) {
      setToast("至少需要保留一个闪充车型和一个普通车型");
      return;
    }
    updateVehicleModel(selectedVehicleModel.id, (m) => changeModelClass(m, newClass));
    setToast(`车型类别已改为${newClass === "flash_capable" ? "闪充" : "普通"}`);
  };

  const handleRestoreDefaultCurve = () => {
    if (!selectedVehicleModel) return;
    updateVehicleModel(selectedVehicleModel.id, (m) => restoreDefaultCurveHelper(m));
    setToast("已恢复类别默认曲线");
  };

  const handleDeleteModel = () => {
    if (!selectedVehicleModel) return;
    const result = deleteVehicleModelHelper(config.vehicleModels, selectedVehicleModel.id);
    if (!result.ok) { setToast(result.error); setShowDeleteModel(false); return; }
    setConfig((current) => ({ ...current, vehicleModels: result.models }));
    setSelectedVehicleModelId(resolveVehicleModelId(result.models));
    setShowDeleteModel(false);
    setToast(`已删除车型"${selectedVehicleModel.name}"`);
  };

  const handleUpdateCapacity = (value: number) => {
    if (!selectedVehicleModel || !Number.isFinite(value) || value < CAPACITY_MIN_KWH || value > CAPACITY_MAX_KWH) return;
    updateVehicleModel(selectedVehicleModel.id, (m) => ({ ...m, usableBatteryCapacityKWh: value }));
  };

  const addVehicle = () => {
    const quantity = Math.max(1, Math.min(30, Math.round(manual.quantity)));
    const model = config.vehicleModels.find((m) => m.id === manualVehicleModelId) ?? config.vehicleModels[0];
    if (!model) return;
    setState((current) => {
      let next = current;
      for (let index = 0; index < quantity; index += 1) {
        next = addManualVehicle(next, config, {
          vehicleModelId: model.id,
          capacity: manual.capacity,
          maxPower: manual.maxPower,
          initialSoc: manual.initialSoc,
          targetSoc: manual.targetSoc,
        });
      }
      return next;
    });
    setShowAdd(false);
    setToast(`${quantity} 辆${model.name}已加入站点`);
  };

  const exportScenario = () => download("兆瓦闪充站场景.json", JSON.stringify(config, null, 2), "application/json");
  const saveScenario = () => {
    localStorage.setItem(`flash-sim-saved-${config.scenarioName}`, JSON.stringify(config));
    setToast("场景已保存到本机");
  };
  const exportCsv = () => {
    const header = "车辆编号,车辆类别,状态,初始SOC,当前SOC,目标SOC,当前功率kW,等待秒数,充电秒数,充入电量kWh,枪口\n";
    const rows = state.vehicles.map((vehicle) => [vehicle.id, vehicle.chargingClass, statusNames[vehicle.status], vehicle.initialSocPercent, vehicle.currentSocPercent.toFixed(2), vehicle.targetSocPercent, vehicle.actualPowerKw.toFixed(1), vehicleWaitDuration(vehicle, state.timeSec), vehicleChargeDuration(vehicle, state.timeSec), vehicle.deliveredEnergyKWh.toFixed(2), vehicle.assignedConnectorId ?? ""].join(",")).join("\n");
    download("车辆运营明细.csv", `\ufeff${header}${rows}`, "text/csv;charset=utf-8");
  };

  const importScenario = async (file?: File) => {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const result = parseSimulationConfig(parsed);
      if (!result.ok) {
        setToast(`导入失败：${result.error}`);
        return;
      }
      setConfig(result.config);
      setSelectedVehicleModelId(resolveVehicleModelId(result.config.vehicleModels));
      reset(result.config);
      setToast("场景导入成功");
    } catch (error) {
      setToast(`导入失败：${error instanceof Error ? error.message : "文件格式错误"}`);
    }
  };

  const selectedLiveVehicle = selectedVehicle ? state.vehicles.find((vehicle) => vehicle.id === selectedVehicle.id) ?? selectedVehicle : null;
  const selectedEstimate = selectedLiveVehicle ? estimateVehicleWaitTime(selectedLiveVehicle.id, state, config) : null;
  const selectedRemainingCharge = selectedLiveVehicle && ["moving_to_bay", "connecting", "charging"].includes(selectedLiveVehicle.status) ? estimateRemainingChargeTime(selectedLiveVehicle) : 0;

  const diagnostics = (() => {
    if (state.gridControl.mode === "outage") return `电网已手动断电，当前充电与基础负荷仅由储能支撑；储能达到最低 SOC 后站端输出将降为 0。`;
    if (state.gridControl.mode === "limited") return `电网正在执行 ${effectiveGridLimit}kW 临时功率上限，储能会在能力范围内补足车辆充电需求。`;
    if (!connectorB.currentVehicleId && standardWaiting > 0 && flashWaiting === 0) return `虽然 B 专用枪当前空闲，但队列中的 ${standardWaiting} 辆车均为普通车辆，只能等待 A 通用枪。`;
    const aVehicle = state.vehicles.find((vehicle) => vehicle.id === connectorA.currentVehicleId);
    if (aVehicle?.chargingClass === "flash_capable" && standardWaiting > 0) return `A 通用枪正由闪充车辆使用，${standardWaiting} 辆普通车辆无法使用 B 枪；可切换"通用枪普通车优先"。`;
    if (connectorA.requestedPowerKw + connectorB.requestedPowerKw > config.pileAggregateMaxPowerKw) return `双枪合计请求 ${Math.round(connectorA.requestedPowerKw + connectorB.requestedPowerKw)}kW，受到每桩 ${config.pileAggregateMaxPowerKw}kW 上限限制。`;
    return "角色感知调度正常：B 枪优先匹配闪充车，A 枪服务剩余最早兼容车辆。";
  })();
  const mobileAlertLabel = state.gridControl.mode === "outage" ? "电网断电" : state.gridControl.mode === "limited" ? "电网限功率" : activeLimit ? "功率受限" : "兼容性等待";

  const toggleRunning = () => setRunning((value) => !value);
  const stepOnce = () => setState((current) => stepSimulation(current, config, 1));
  const changeSpeed = (value: number) => setSpeed(value);
  const selectMobileAnalysis = (view: MobileAnalysisView, desktopTab?: Tab) => {
    setMobileAnalysisView(view);
    if (desktopTab) setTab(desktopTab);
  };

  return (
    <div className={`app-shell ${activeDialog ? "overlay-open" : ""}`}>
      <header className="topbar">
        <div className="product-context">
          <div className="brand-block"><h1>兆瓦闪充站仿真</h1></div>
          <label className="scenario-select"><span>场景</span><select value={config.scenarioName} onChange={(event) => selectScenario(event.target.value)}>{Object.keys(scenarioPresets).map((name) => <option key={name}>{name}</option>)}</select></label>
        </div>
        <div className="simulation-status" aria-live="polite">
          <span className={`run-state ${running ? "running" : "paused"}`}>{running ? "运行中" : "已暂停"}</span>
          <div className="clock-block"><span>仿真时间</span><strong>{formatTime(state.timeSec + 8 * 3600)}</strong></div>
        </div>
        <div className="transport-controls" role="group" aria-label="仿真控制">
          <button className="primary-action" onClick={toggleRunning}>{running ? "暂停" : "继续"}</button>
          <button className="secondary-action" onClick={stepOnce} disabled={running}>单步</button>
          <label className="speed-control"><span>速度</span><select aria-label="仿真速度" value={speed} onChange={(event) => changeSpeed(Number(event.target.value))}>{speedOptions.map((value) => <option value={value} key={value}>{value}×</option>)}</select></label>
        </div>
        <div className="scenario-actions" role="group" aria-label="场景管理">
          <button className="secondary-action" onClick={saveScenario}>保存</button>
          <button className="secondary-action" onClick={() => importRef.current?.click()}>导入</button>
          <button className="secondary-action" onClick={exportScenario}>导出</button>
          <button className="danger-action" onClick={() => setShowReset(true)}>重置</button>
        </div>
        <div className="utility-actions" role="group" aria-label="显示与帮助">
          <button className="quiet-action" onClick={() => setTheme((value) => value === "dark" ? "light" : "dark")} aria-label="切换深浅主题">{theme === "dark" ? "浅色" : "深色"}</button>
          <button className="quiet-action" onClick={() => setShowHelp(true)}>帮助</button>
          <input ref={importRef} hidden type="file" accept="application/json,.json" onChange={(event) => importScenario(event.target.files?.[0])} />
        </div>
      </header>

      <header className="mobile-status-header">
        <div className="mobile-product"><strong>闪充站仿真</strong><span>{config.scenarioName}</span></div>
        <div className="mobile-simulation-status" aria-live="polite"><span className={`run-state ${running ? "running" : "paused"}`}>{running ? "运行中" : "已暂停"}</span><strong>{formatTime(state.timeSec + 8 * 3600)}</strong></div>
      </header>

      <nav className="mobile-view-switch" aria-label="移动任务视图">
        {(["station", "control", "analysis"] as const).map((view) => <button key={view} type="button" aria-pressed={mobileView === view} className={mobileView === view ? "active" : ""} onClick={() => setMobileView(view)}>{view === "station" ? "站场" : view === "control" ? "控制" : "分析"}</button>)}
      </nav>

      <div className="model-disclaimer">本项目为非官方仿真工具。部分预设参数根据公开资料整理或拟合，仅用于技术演示，不代表厂商实际控制策略或设备性能承诺。</div>

      <main className={`dashboard-grid ${queueExpanded ? "queue-expanded" : "queue-collapsed"}`} style={{ "--station-row-height": stationCollapsedHeight ? `${stationCollapsedHeight}px` : undefined } as CSSProperties}>
        <div className={`task-view task-view-control ${mobileView === "control" ? "active" : ""}`}>
        <aside className="config-panel panel">
          <div className="panel-title control-panel-title"><div><h2><span className="desktop-only">站点参数</span><span className="mobile-only">实验控制</span></h2></div><span className="live-pill">实时</span></div>
          <section className="parameter-section quick-controls" aria-labelledby="quick-controls-title">
            <div className="parameter-section-heading"><div><h3 id="quick-controls-title">快速控制</h3><p>仿真运行中即时生效</p></div><span>常用</span></div>

            <div className="control-group">
              <div className="control-group-title"><strong><span className="desktop-only">车辆到达</span><span className="mobile-only">车辆流量</span></strong><span>{config.arrivalRatePerHour} 辆/h · 闪充 {Math.round(config.flashShare * 100)}%</span></div>
              <label className="switch-row"><span>自动生成车辆<small>按当前到达率持续生成</small></span><input type="checkbox" checked={config.autoArrivalEnabled} onChange={(event) => updateConfig("autoArrivalEnabled", event.target.checked)} /></label>
              <div className="quick-parameter-grid">
                <ParameterRow label="平均到达率" value={config.arrivalRatePerHour} min={0} max={60} step={1} unit="辆/h" onChange={(value) => updateConfig("arrivalRatePerHour", value)} />
                <ParameterRow label="闪充车辆占比" value={Math.round(config.flashShare * 100)} min={0} max={100} step={5} unit="%" onChange={(value) => updateConfig("flashShare", value / 100)} />
              </div>
              <button className="wide-button" onClick={() => { const modelId = resolveVehicleModelId(config.vehicleModels, selectedVehicleModelId); setManualVehicleModelId(modelId); const model = config.vehicleModels.find((m) => m.id === modelId); if (model) setManual((v) => ({ ...v, capacity: model.usableBatteryCapacityKWh, maxPower: model.chargingClass === "flash_capable" ? 1500 : 520 })); setShowAdd(true); }}>手动添加车辆</button>
            </div>

            <div className={`control-group grid-disturbance ${state.gridControl.mode}`}>
              <div className="control-group-title"><strong>电网运行扰动</strong><span className={state.gridControl.mode === "normal" ? "quiet-status" : "warning-text"}>{state.gridControl.mode === "outage" ? "已断电" : state.gridControl.mode === "limited" ? `限至 ${Math.round(effectiveGridLimit)} kW` : "正常供电"}</span></div>
              <ParameterRow label="临时功率上限" value={gridLimitDraft} min={0} max={2500} step={20} unit="kW" showSlider={false} onChange={setGridLimitDraft} />
              <div className="grid-fault-actions"><button className="outage-button" onClick={() => setState((current) => setGridControl(current, "outage"))}>模拟断电</button><button onClick={() => setState((current) => setGridControl(current, "limited", gridLimitDraft))}>启用限功率</button><button className="restore-button" onClick={() => setState((current) => setGridControl(current, "normal"))}>恢复供电</button></div>
            </div>

            <div className="control-group storage-intervention">
              <div className="control-group-title"><strong>储能电量干预</strong><span>{storageSoc.toFixed(1)}% SOC</span></div>
              <ParameterRow label="当前电量" value={Math.round(state.storage.energyKWh)} min={0} max={Math.round(state.storage.capacityKWh)} step={5} unit="kWh" onChange={(value) => setState((current) => setStorageEnergy(current, value))} />
              <div className="soc-bar"><i style={{ width: `${storageSoc}%` }} /><span>{state.storage.energyKWh.toFixed(1)} / {state.storage.capacityKWh} kWh</span></div>
              <div className="storage-quick-actions" aria-label="快速设置储能电量">{[20, 50, 80, 100].map((percent) => <button key={percent} onClick={() => setState((current) => setStorageEnergy(current, current.storage.capacityKWh * percent / 100))}>{percent}%</button>)}</div>
            </div>
          </section>

          <div className="parameter-section-heading section-divider"><div><h3>场景参数</h3><p>定义站点能力与资源边界</p></div></div>
          <details className="scene-parameter" open>
            <summary><span>01</span>电网与母线<small>{config.gridMaxPowerKw} kW · 母线 {config.stationBusMaxPowerKw} kW</small></summary>
            <div className="detail-body">
              <ParameterRow label="电网最大有功功率" value={config.gridMaxPowerKw} min={120} max={2500} step={20} unit="kW" onChange={(value) => updateConfig("gridMaxPowerKw", value)} />
              <ParameterRow label="站内基础负荷" value={config.baseLoadKw} min={0} max={200} step={5} unit="kW" onChange={(value) => updateConfig("baseLoadKw", value)} />
              <ParameterRow label="直流母线上限" value={config.stationBusMaxPowerKw} min={800} max={4200} step={100} unit="kW" onChange={(value) => updateConfig("stationBusMaxPowerKw", value)} />
              <div className="micro-stats"><span>当前有效上限<strong>{Math.round(effectiveGridLimit)} kW</strong></span><span>剩余容量<strong>{Math.max(0, Math.round(effectiveGridLimit - state.gridPowerKw))} kW</strong></span></div>
            </div>
          </details>
          <details className="scene-parameter">
            <summary><span>02</span>储能系统<small>{config.storageCapacityKWh} kWh · Min SOC {config.storageMinSocPercent}%</small></summary>
            <div className="detail-body">
              <ParameterRow label="额定容量" value={config.storageCapacityKWh} min={100} max={1000} step={20} unit="kWh" onChange={(value) => { updateConfig("storageCapacityKWh", value); setState((current) => { const soc = current.storage.energyKWh / Math.max(1, current.storage.capacityKWh); return { ...current, storage: { ...current.storage, capacityKWh: value, energyKWh: Math.min(value, value * soc) } }; }); }} />
              <ParameterRow label="最大放电功率" value={config.storageMaxDischargePowerKw} min={0} max={2000} step={50} unit="kW" onChange={(value) => { updateConfig("storageMaxDischargePowerKw", value); setState((current) => ({ ...current, storage: { ...current.storage, maxDischargePowerKw: value } })); }} />
              <ParameterRow label="最低 SOC" value={config.storageMinSocPercent} min={5} max={50} step={1} unit="%" onChange={(value) => { updateConfig("storageMinSocPercent", value); setState((current) => ({ ...current, storage: { ...current.storage, minSocPercent: value } })); }} />
              <ParameterRow label="最大充电功率" value={config.storageMaxChargePowerKw} min={300} max={2500} step={50} unit="kW" onChange={(value) => { updateConfig("storageMaxChargePowerKw", value); setState((current) => ({ ...current, storage: { ...current.storage, maxChargePowerKw: value } })); }} />
            </div>
          </details>
          <details className="scene-parameter">
            <summary><span>03</span>双枪充电设施<small>单枪 {config.connectorMaxPowerKw} · 整桩 {config.pileAggregateMaxPowerKw} kW</small></summary>
            <div className="detail-body">
              <ParameterRow label="单枪硬件上限" value={config.connectorMaxPowerKw} min={200} max={1500} step={50} unit="kW" onChange={(value) => updateConfig("connectorMaxPowerKw", value)} />
              <ParameterRow label="整桩合计上限" value={config.pileAggregateMaxPowerKw} min={500} max={3000} step={50} unit="kW" onChange={(value) => updateConfig("pileAggregateMaxPowerKw", value)} />
            </div>
          </details>

          <details className="advanced-settings">
            <summary><span>高级</span>模型与调度<small>{policyNames[config.pilePolicy]} · {queuePolicyNames[config.queuePolicy]}</small></summary>
            <div className="detail-body advanced-body">
              <section className="advanced-group">
                <h4>功率分配</h4>
                <label className="select-row">桩内功率策略<select value={config.pilePolicy} onChange={(event) => updateConfig("pilePolicy", event.target.value as SimulationConfig["pilePolicy"])}>{Object.entries(policyNames).map(([value, name]) => <option value={value} key={value}>{name}</option>)}</select></label>
                <label className="check-row"><input type="checkbox" checked={config.universalPolicyCapKw !== undefined} onChange={(event) => updateConfig("universalPolicyCapKw", event.target.checked ? 480 : undefined)} />A 枪启用 480 kW 案例策略上限</label>
              </section>
              <section className="advanced-group">
                <h4>队列与等待</h4>
                <label className="select-row">调度算法<select value={config.queuePolicy} onChange={(event) => updateConfig("queuePolicy", event.target.value as SimulationConfig["queuePolicy"])}>{Object.entries(queuePolicyNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
                {config.maxAcceptableWaitSec !== null && <ParameterRow label="最大可接受等待" value={Math.round(config.maxAcceptableWaitSec / 60)} min={1} max={720} step={5} unit="分钟" onChange={(value) => updateMaxAcceptableWait(value * 60)} />}
                <label className="check-row"><input type="checkbox" checked={config.maxAcceptableWaitSec === null} onChange={(event) => updateMaxAcceptableWait(event.target.checked ? null : 30 * 60)} />无限等待，不因超时弃队</label>
              </section>
              <section className="advanced-group">
                <h4>会话时序</h4>
                <ParameterRow label="车位换车周转" value={config.turnoverSec ?? 60} min={0} max={300} step={15} unit="秒" onChange={(value) => updateConfig("turnoverSec", value)} />
                <div className="model-value-list"><span>驶入 <strong>{config.movementSec} 秒</strong></span><span>握手 <strong>{config.handshakeSec} 秒</strong></span><span>断开 <strong>{config.disconnectSec} 秒</strong></span><span>随机种子 <strong>{config.randomSeed}</strong></span></div>
              </section>
              <details className="parameter-notes">
                <summary>查看模型说明</summary>
                <div><p>策略变化只影响后续分配，不迁移正在充电的车辆。</p><p>换车周转包含车辆驶离、车位确认与下一车进位准备；无限等待关闭时，超时车辆会记为弃队。</p></div>
              </details>
            </div>
          </details>

          <details className="mobile-scenario-tools">
            <summary><span>工具</span><strong>场景与工具</strong><small>保存 · 导入导出 · 显示</small></summary>
            <div className="mobile-scenario-tools-body">
              <label className="mobile-scenario-select"><span>当前场景</span><select value={config.scenarioName} onChange={(event) => selectScenario(event.target.value)}>{Object.keys(scenarioPresets).map((name) => <option key={name}>{name}</option>)}</select></label>
              <div className="mobile-tool-actions" role="group" aria-label="移动场景管理">
                <button type="button" onClick={saveScenario}>保存场景</button>
                <button type="button" onClick={() => importRef.current?.click()}>导入配置</button>
                <button type="button" onClick={exportScenario}>导出配置</button>
                <button type="button" className="danger-action" onClick={() => setShowReset(true)}>重置仿真</button>
              </div>
              <div className="mobile-utility-actions" role="group" aria-label="移动显示与帮助">
                <button type="button" className="quiet-action" onClick={() => setTheme((value) => value === "dark" ? "light" : "dark")}>{theme === "dark" ? "切换浅色主题" : "切换深色主题"}</button>
                <button type="button" className="quiet-action" onClick={() => setShowHelp(true)}>打开帮助</button>
              </div>
            </div>
          </details>
        </aside>
        </div>

        <div className={`task-view task-view-station ${mobileView === "station" ? "active" : ""}`}>
        <section ref={stationPanelRef} className="station-panel panel">
          <div className="panel-title station-title"><div><h2>01# 兆瓦闪充站 · 双枪作业</h2></div><div className="station-status"><span className={activeLimit || state.gridControl.mode !== "normal" ? "warning-text" : "ok-text"}>{state.gridControl.mode === "outage" ? "电网断电 · 储能支撑" : state.gridControl.mode === "limited" ? `电网临时限至 ${effectiveGridLimit}kW` : activeLimit ? "功率受限" : "运行正常"}</span><small>T+{formatTime(state.timeSec)}</small></div></div>
          {stationNoticeActive && <div className={`mobile-station-alert ${state.gridControl.mode === "outage" ? "critical" : "warning"}`} role="status"><strong>{mobileAlertLabel}</strong><span>{diagnostics}</span></div>}
          <section className="mobile-station-summary" aria-label="站级关键状态">
            <div><span>站端输出</span><strong>{Math.round(state.chargingPowerKw).toLocaleString("zh-CN")}<small>kW</small></strong></div>
            <div><span>电网输入</span><strong>{Math.round(state.gridPowerKw).toLocaleString("zh-CN")}<small>kW</small></strong></div>
            <div><span>储能 SOC</span><strong>{storageSoc.toFixed(1)}<small>%</small></strong></div>
            <div><span>排队车辆</span><strong>{state.queue.length}<small>辆</small></strong></div>
          </section>
          <div className="energy-summary" aria-label="电网、直流母线与储能功率流向">
            <article className={`energy-summary-item grid-node ${state.gridControl.mode}`}><span className="energy-node-mark">电网</span><div><span className="energy-node-label">电网输入</span><strong>{Math.round(state.gridPowerKw).toLocaleString("zh-CN")}<small>kW</small></strong><p>{gridStatusLabel} · 上限 {Math.round(effectiveGridLimit).toLocaleString("zh-CN")}</p></div></article>
            <div className={`energy-flow-line ${state.gridPowerKw > 0 ? "active" : ""}`} aria-label={`电网向母线输入 ${Math.round(state.gridPowerKw).toLocaleString("zh-CN")} kW`}><span aria-hidden="true">→</span><small>送入母线</small><b>{Math.round(state.gridPowerKw).toLocaleString("zh-CN")} kW</b></div>
            <article className="energy-summary-item bus-node"><span className="energy-node-mark">母线</span><div><span className="energy-node-label">直流母线</span><strong>{Math.round(busLoadPowerKw).toLocaleString("zh-CN")}<small>kW</small></strong><p>车辆 {Math.round(state.chargingPowerKw).toLocaleString("zh-CN")} · 基础 {config.baseLoadKw}</p></div></article>
            <div className={`energy-flow-line storage-flow ${state.storage.powerKw !== 0 ? "active" : ""}`} aria-label={`${storageFlowLabel} ${Math.round(storageFlowPowerKw).toLocaleString("zh-CN")} kW`}><span aria-hidden="true">{storageFlowDirection}</span><small>{storageFlowLabel}</small><b>{Math.round(storageFlowPowerKw).toLocaleString("zh-CN")} kW</b></div>
            <article className="energy-summary-item storage-node"><span className="energy-node-mark">储能</span><div><span className="energy-node-label">储能系统</span><strong>{storageSoc.toFixed(1)}<small>% SOC</small></strong><p>{storageStateLabel}{state.storage.powerKw !== 0 ? ` ${Math.round(storageFlowPowerKw).toLocaleString("zh-CN")} kW` : ""} · {state.storage.energyKWh.toFixed(1)} kWh</p></div></article>
          </div>

          <div className="station-workspace">
            <section className="pile-workspace" aria-label={pile.name}>
              <header className="pile-overview"><div><h3>{pile.name}</h3><p>单枪上限 {config.connectorMaxPowerKw.toLocaleString("zh-CN")} kW · {policyNames[config.pilePolicy]}</p></div><div className="pile-output"><span>双枪实际 / 请求</span><strong>{Math.round(pileActualPowerKw).toLocaleString("zh-CN")}<small>/ {Math.round(pileRequestedPowerKw).toLocaleString("zh-CN")} kW</small></strong><p>整桩共享上限 {config.pileAggregateMaxPowerKw.toLocaleString("zh-CN")} kW</p></div></header>
              <div className={`shared-meter ${pileRequestedPowerKw > pileActualPowerKw + 1 ? "limited" : ""}`}><i style={{ width: `${Math.min(100, pileActualPowerKw / config.pileAggregateMaxPowerKw * 100)}%` }} /></div>
              <div className="bay-grid"><ConnectorBay connector={connectorA} state={state} config={config} onVehicle={setSelectedVehicle} /><ConnectorBay connector={connectorB} state={state} config={config} onVehicle={setSelectedVehicle} /></div>
              <div className="pile-context"><span>A {Math.round(connectorA.actualPowerKw).toLocaleString("zh-CN")} kW</span><span className={activeLimit ? "warning-text" : ""}>{activeLimit ? "实际功率低于请求" : "按当前请求输出"}</span><span>B {Math.round(connectorB.actualPowerKw).toLocaleString("zh-CN")} kW</span></div>
            </section>
            <section className="queue-zone" aria-label="车辆等候队列">
              <div className="queue-label"><div><strong>等候队列</strong><span>单一全局队列 · 按现有调度策略分配</span></div><p><strong>{state.queue.length}</strong> 辆 · 闪充 {flashWaiting} · 普通 {standardWaiting}</p></div>
              <div ref={queueListRef} className={`queue-list ${queueExpanded ? "expanded" : ""}`} id="station-queue-list">{visibleQueueIds.map((id, index) => { const vehicle = state.vehicles.find((item) => item.id === id)!; const estimate = estimateVehicleWaitTime(id, state, config); const eligibility = vehicle.chargingClass === "flash_capable" ? "闪充 · A/B" : "普通 · 仅 A"; return <button className="queue-item" key={id} title={`${vehicle.id} · ${vehicle.chargingClass === "flash_capable" ? "闪充兼容，可用 A / B" : "普通直流，仅可用 A"} · 预计等待 ${formatDuration(estimate.expectedWaitSec)}`} onClick={() => setSelectedVehicle(vehicle)}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{vehicle.id}</strong><small>{eligibility}</small></div><em>约 {formatDuration(estimate.expectedWaitSec)}</em></button>; })}{state.queue.length === 0 && <span className="empty-queue">当前没有等待车辆</span>}{hiddenQueueCount > 0 && <button className="queue-more" aria-expanded={queueExpanded} aria-controls="station-queue-list" onClick={() => setQueueExpanded((value) => !value)}>{queueExpanded ? <><strong>收起队列</strong><small>保留前 {queuePreviewLimit} 辆</small></> : <><strong>另有 {hiddenQueueCount} 辆</strong><small>展开全部</small></>}</button>}</div>
              <div className={`station-diagnostic ${stationNoticeActive ? "active" : ""}`}><span>{stationNoticeActive ? "需关注" : "调度正常"}</span><p>{diagnostics}</p></div>
            </section>
          </div>
          <section className="mobile-energy-summary" aria-label="移动供能关系">
            <header><h3>供能关系</h3><span>储能正值放电 / 负值充电</span></header>
            <div><span>电网输入</span><strong>{Math.round(state.gridPowerKw).toLocaleString("zh-CN")}<small>kW</small></strong><em>{gridStatusLabel}</em></div>
            <div><span>储能净功率</span><strong>{state.storage.powerKw >= 0 ? "+" : "−"}{Math.round(storageFlowPowerKw).toLocaleString("zh-CN")}<small>kW</small></strong><em>{storageStateLabel} · SOC {storageSoc.toFixed(1)}%</em></div>
            <div className="total"><span>直流母线负载</span><strong>{Math.round(busLoadPowerKw).toLocaleString("zh-CN")}<small>kW</small></strong><em>车辆 {Math.round(state.chargingPowerKw).toLocaleString("zh-CN")} · 基础 {config.baseLoadKw}</em></div>
          </section>
        </section>

        <aside className="metrics-panel panel">
          <div className="panel-title"><div><h2>实时运营</h2></div><span className="sign-rule">储能 +放 / −充</span></div>
          <div className="metric-grid" aria-live="polite">
            <MetricCard label="站端输出" value={formatPower(state.chargingPowerKw)} note={`峰值上限 ${config.stationBusMaxPowerKw}kW`} accent="amber" />
            <MetricCard label="电网功率" value={formatPower(state.gridPowerKw)} note={`${gridStatusLabel} · 余量 ${Math.max(0, effectiveGridLimit - state.gridPowerKw).toFixed(0)}kW`} accent={state.gridControl.mode === "outage" ? "red" : "blue"} />
            <MetricCard label="储能净功率" value={`${state.storage.powerKw >= 0 ? "+" : "−"}${formatPower(Math.abs(state.storage.powerKw))}`} note={state.storage.powerKw > 0 ? "正在削峰放电" : state.storage.powerKw < 0 ? "谷段补能" : "当前待机"} accent="green" />
            <MetricCard label="储能综合 SOC" value={`${storageSoc.toFixed(1)}%`} note={`${state.storage.energyKWh.toFixed(1)}kWh 可用`} accent="green" />
            <MetricCard label="正在充电" value={`${chargingVehicles.length} 辆`} note={`已完成 ${completedVehicles.length} 辆`} />
            <MetricCard label="排队车辆" value={`${state.queue.length} 辆`} note={`闪充 ${flashWaiting} · 普通 ${standardWaiting}`} accent={state.queue.length > 3 ? "red" : undefined} />
            <MetricCard label="平均等待" value={formatDuration(average(allWaits))} note={`闪充 ${formatDuration(average(flashWaits))}`} />
            <MetricCard label="普通车等待" value={formatDuration(average(standardWaits))} note="仅计 A 通用枪服务能力" accent={standardWaits.length && average(standardWaits) > average(flashWaits) * 1.5 ? "red" : undefined} />
          </div>
          <section className={`grid-utilization-panel ${hasGridDisturbanceOccurred ? "split" : ""}`} aria-label="累计电网利用率">
            {hasGridDisturbanceOccurred && <h3>电网利用率</h3>}
            <GridUtilizationRow label={hasGridDisturbanceOccurred ? "额定容量" : "电网利用率"} accessibleLabel="电网额定容量利用率" percent={ratedGridUtilizationPercent} importEnergyKWh={state.cumulativeGridImportEnergyKWh ?? 0} capacityEnergyKWh={state.cumulativeRatedGridCapacityEnergyKWh ?? 0} capacityLabel={hasGridDisturbanceOccurred ? "额定理论" : "理论容量"} />
            {hasGridDisturbanceOccurred && <GridUtilizationRow label="可用容量" accessibleLabel="电网可用容量利用率" percent={availableGridUtilizationPercent} importEnergyKWh={state.cumulativeGridImportEnergyKWh ?? 0} capacityEnergyKWh={state.cumulativeAvailableGridCapacityEnergyKWh ?? 0} capacityLabel="可用理论" secondary />}
            <small className="grid-utilization-time">统计 T+{formatTime(state.timeSec)}{hasGridDisturbanceOccurred ? " · 已计入电网扰动" : " · 按额定接入容量累计"}</small>
          </section>
          <div className="utilization-panel"><h3>枪口利用率</h3><div className="utilization-row"><div className="utilization-label"><span>A 通用枪</span><b>{state.timeSec ? Math.round(connectorA.busySec / state.timeSec * 100) : 0}%</b></div><i><em style={{ width: `${state.timeSec ? Math.min(100, connectorA.busySec / state.timeSec * 100) : 0}%` }} /></i></div><div className="utilization-row"><div className="utilization-label"><span>B 闪充专用</span><b>{state.timeSec ? Math.round(connectorB.busySec / state.timeSec * 100) : 0}%</b></div><i><em style={{ width: `${state.timeSec ? Math.min(100, connectorB.busySec / state.timeSec * 100) : 0}%` }} /></i></div><small>专用枪不兼容空闲 {formatDuration(connectorB.incompatibleIdleSec)}</small></div>
          <div className={`limit-card ${activeLimit ? "active" : ""}`}><span>{activeLimit ? "!" : "✓"}</span><div><strong>{activeLimit ? "当前存在功率限制" : "功率约束均满足"}</strong><p>{activeLimit ? `${policyNames[config.pilePolicy]}：A/B 实际功率受整桩或站级上限约束。` : "单枪 ≤1500kW · 整桩 ≤2100kW"}</p></div></div>
        </aside>
        </div>

        <div className={`task-view task-view-analysis mobile-analysis-${mobileAnalysisView} ${mobileView === "analysis" ? "active" : ""}`}>
        <nav className="mobile-analysis-nav" aria-label="移动分析视图">
          <div className="mobile-analysis-primary" role="tablist" aria-label="高频分析任务">
            <button type="button" role="tab" aria-selected={mobileAnalysisView === "trend"} className={mobileAnalysisView === "trend" ? "active" : ""} onClick={() => selectMobileAnalysis("trend")}>趋势</button>
            <button type="button" role="tab" aria-selected={mobileAnalysisView === "vehicles"} className={mobileAnalysisView === "vehicles" ? "active" : ""} onClick={() => selectMobileAnalysis("vehicles", "车辆")}>车辆</button>
            <button type="button" role="tab" aria-selected={mobileAnalysisView === "events"} className={mobileAnalysisView === "events" ? "active" : ""} onClick={() => selectMobileAnalysis("events", "事件")}>事件</button>
            <button type="button" role="tab" aria-selected={mobileAnalysisView === "results"} className={mobileAnalysisView === "results" ? "active" : ""} onClick={() => selectMobileAnalysis("results", "运营结果")}>结果</button>
          </div>
          <div className="mobile-analysis-research" aria-label="研究工具">
            <button type="button" className={mobileAnalysisView === "model" ? "active" : ""} onClick={() => selectMobileAnalysis("model", "模型 · 车型与曲线")}>模型与曲线</button>
            <button type="button" className={mobileAnalysisView === "reference" ? "active" : ""} onClick={() => selectMobileAnalysis("reference", "参考 · 参数来源")}>参数来源</button>
          </div>
        </nav>
        <section className="trend-overview panel mobile-analysis-trend">
          <div className="trend-overview-head">
            <div><h2>站点实时曲线</h2><p>电网、储能与车辆功率，最多显示最近 30 分钟</p></div>
            <div className="trend-overview-actions"><button className="trend-sample-control" aria-label="调整趋势采样间隔" title="点击切换趋势采样间隔" onClick={() => { const currentIndex = sampleOptions.indexOf(config.historySampleSec ?? 5); updateConfig("historySampleSec", sampleOptions[(currentIndex + 1) % sampleOptions.length]); }}>采样间隔 <strong>{config.historySampleSec ?? 5}</strong><span>s</span></button><div className="trend-kpis"><span>车辆<strong>{formatPower(state.chargingPowerKw)}</strong></span><span>储能<strong>{state.storage.energyKWh.toFixed(1)} kWh</strong></span><span>队列<strong>{state.queue.length} 辆</strong></span><span>电网<strong>{gridStatusLabel}</strong></span></div></div>
          </div>
          <TrendCanvas history={state.history} storageCapacityKWh={state.storage.capacityKWh} storageMinSocPercent={state.storage.minSocPercent} currentStorageEnergyKWh={state.storage.energyKWh} currentStorageSocPercent={storageSoc} sampleIntervalSec={config.historySampleSec ?? 5} />
        </section>

        <section className="data-panel panel mobile-analysis-data">
          <nav className="tabs" aria-label="数据视图">{tabs.map(({ name, kind }) => <button className={`${tab === name ? "active " : ""}tab-${kind}`} key={name} onClick={() => setTab(name)}>{name}{name === "事件" && state.events.length > 0 && <span>{Math.min(99, state.events.length)}</span>}</button>)}{tab === "车辆" && <button className="export-csv" onClick={exportCsv}>导出车辆 CSV</button>}</nav>
          {tab === "车辆" && <>
            <div className="mobile-analysis-toolbar"><span>{state.vehicles.length} 辆车辆</span><button type="button" onClick={exportCsv}>导出车辆 CSV</button></div>
            <MobileVehicleList state={state} config={config} onVehicle={setSelectedVehicle} />
            <div className="tab-content table-wrap desktop-vehicle-table"><table><thead><tr><th>车辆</th><th>车型</th><th>状态</th><th className="table-number">SOC</th><th className="table-number">功率</th><th className="table-number">等待用时</th><th className="table-number">充电用时</th><th className="table-number">预计剩余</th><th>枪口</th><th>限功率原因</th></tr></thead><tbody>{state.vehicles.slice(-50).reverse().map((vehicle) => { const remaining = vehicle.status === "queued" ? estimateVehicleWaitTime(vehicle.id, state, config).expectedWaitSec : ["moving_to_bay", "connecting", "charging"].includes(vehicle.status) ? estimateRemainingChargeTime(vehicle) : 0; const remainingLabel = vehicle.status === "queued" ? `等待 ${formatDuration(remaining)}` : ["moving_to_bay", "connecting", "charging"].includes(vehicle.status) ? `充电 ${formatDuration(remaining)}` : "—"; const visibleLimitReasons = vehicle.limitReasons.filter((reason) => reason !== "none"); return <tr key={vehicle.id} onClick={() => setSelectedVehicle(vehicle)}><td><strong>{vehicle.id}</strong></td><td className="vehicle-model-cell" title={vehicle.name}><span className="vehicle-model-name">{vehicle.name}</span><small>{vehicle.chargingClass === "flash_capable" ? "闪充" : "普通"}</small></td><td><span className={`table-status ${vehicle.status}`}>{statusNames[vehicle.status]}</span></td><td className="table-number">{vehicle.currentSocPercent.toFixed(1)}% → {vehicle.targetSocPercent}%</td><td className="table-number table-power"><span>{Math.round(vehicle.actualPowerKw).toLocaleString("zh-CN")}</span><small>kW</small></td><td className="table-number">{formatDuration(vehicleWaitDuration(vehicle, state.timeSec))}</td><td className="table-number">{vehicle.chargingStartedAtSec === undefined ? "—" : formatDuration(vehicleChargeDuration(vehicle, state.timeSec))}</td><td className="table-number"><span className="remaining-cell">{remainingLabel}</span></td><td>{vehicle.assignedConnectorId ?? "—"}</td><td>{visibleLimitReasons.length ? visibleLimitReasons.join(" / ") : "—"}</td></tr>; })}</tbody></table></div>
          </>}
          {tab === "事件" && <div className="tab-content event-list">{state.events.map((event) => <article key={event.id} className={event.level}><time>T+{formatTime(event.timeSec)}</time><span>{event.message}</span><small title={event.type}>{event.level === "warning" && <b>警告 · </b>}{event.type}</small></article>)}{state.events.length === 0 && <p className="empty-state">仿真事件将在这里记录。</p>}</div>}
          {tab === "运营结果" && <div className="tab-content analytics-grid"><section className="analytics-group"><h3>吞吐结果</h3><MetricCard label="累计到站" value={`${state.totalArrivals} 辆`} note="包含手动与自动车辆" /><MetricCard label="完成率" value={`${state.totalArrivals ? (completedVehicles.length / state.totalArrivals * 100).toFixed(1) : 0}%`} note="当前仿真窗口" /></section><section className="analytics-group"><h3>枪口分工</h3><MetricCard label="A 服务闪充 / 普通" value={`${connectorA.servedFlash} / ${connectorA.servedStandard}`} note="按实际会话统计" /><MetricCard label="B 服务闪充" value={`${connectorB.servedFlash} 辆`} note="普通车辆始终为 0" /><MetricCard label="双枪同时工作" value={`${state.timeSec ? (pile.simultaneousSec / state.timeSec * 100).toFixed(1) : "0.0"}%`} note="整桩时间占比" /></section><section className="analytics-group"><h3>约束损失</h3><MetricCard label="整桩共享上限受限时间" value={`${state.timeSec ? (pile.aggregateLimitedSec / state.timeSec * 100).toFixed(1) : "0.0"}%`} note={`当前上限 ${config.pileAggregateMaxPowerKw.toLocaleString("zh-CN")} kW · ${formatDuration(pile.aggregateLimitedSec)}`} /><MetricCard label="受限减少电量" value={`${pile.curtailedEnergyKWh.toFixed(2)} kWh`} note="相对枪口请求估算" /></section><section className="analytics-group"><h3>储能贡献</h3><MetricCard label="储能累计放电" value={`${state.storage.cumulativeDischargeKWh.toFixed(1)} kWh`} note={`等效循环 ${(state.storage.cumulativeDischargeKWh / state.storage.capacityKWh).toFixed(3)}`} /></section></div>}
          {tab === "模型 · 车型与曲线" && selectedVehicleModel && <div className="tab-content curve-editor">
            <div className="curve-head">
              <div className="model-toolbar">
                <label className="model-select-row">
                  <span>车型</span>
                  <select title={selectedVehicleModel.name} value={selectedVehicleModel.id} onChange={(event) => setSelectedVehicleModelId(event.target.value)}>{config.vehicleModels.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.chargingClass === "flash_capable" ? "闪充" : "普通"}</option>)}</select>
                </label>
                <div className="model-actions-row">
                  <button className="model-tool-btn" onClick={(event) => { dialogTriggerRef.current = event.currentTarget; setNewModelDraft({ name: "", chargingClass: "flash_capable", capacity: DEFAULT_FLASH_CAPACITY_KWH }); setNewModelError(""); setShowNewModel(true); }}>新建</button>
                  <button className="model-tool-btn" onClick={(event) => { dialogTriggerRef.current = event.currentTarget; setRenameDraft(selectedVehicleModel.name); setRenameError(""); setShowRenameModel(true); }}>重命名</button>
                  {!isDefaultVehicleModel(selectedVehicleModel) && <button className="model-tool-btn danger-btn" onClick={(event) => { dialogTriggerRef.current = event.currentTarget; setShowDeleteModel(true); }}>删除</button>}
                </div>
                <div className="model-props-row">
                  <label><span>类别</span><select value={selectedVehicleModel.chargingClass} onChange={(event) => handleChangeClass(event.target.value as VehicleChargingClass)}><option value="flash_capable">闪充车型</option><option value="standard_dc">普通车型</option></select></label>
                  <label><span>容量</span><input type="number" min={CAPACITY_MIN_KWH} max={CAPACITY_MAX_KWH} step={1} value={selectedVehicleModel.usableBatteryCapacityKWh} onChange={(event) => handleUpdateCapacity(Number(event.target.value))} /><small>kWh</small></label>
                  <button className="model-tool-btn restore-btn" onClick={handleRestoreDefaultCurve}>恢复默认曲线</button>
                </div>
              </div>
              <p>模型输入，修改仅影响之后生成的车辆。点击并上下拖动柱体即可调节功率。</p>
            </div>
            <div className="mobile-curve-heading"><strong>充电曲线</strong><span>Y 充电功率 kW · X SOC %</span></div>
            <div className="curve-bars" aria-label={`${selectedVehicleModel.name} 可拖动充电曲线`}>{selectedVehicleModel.chargingCurve.map((point, index) => <button type="button" className={`curve-bar ${selectedVehicleModel.chargingClass === "standard_dc" ? "standard" : ""}`} key={`${selectedVehicleModel.id}-${point.soc}-${index}`} style={{ height: `${Math.max(2, point.powerKw / 1500 * 100)}%` }} role="slider" aria-label={`SOC ${point.soc}% 功率 ${point.powerKw}kW`} aria-valuemin={0} aria-valuemax={1500} aria-valuenow={point.powerKw} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); updateCurveFromPointer(index, event); }} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) updateCurveFromPointer(index, event); }} onKeyDown={(event) => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); updateCurvePower(index, point.powerKw + (event.key === "ArrowUp" ? 10 : -10)); } }}><span>{point.powerKw}</span><i>⇅</i><small>{point.soc}%</small></button>)}</div>
            <div className="curve-table"><div className="mobile-curve-table-head"><strong>控制点</strong><span>SOC / 最大功率</span></div>{selectedVehicleModel.chargingCurve.map((point, index) => <label key={`${selectedVehicleModel.id}-${point.soc}-${index}`}><span>SOC <input type="number" inputMode="decimal" min="0" max="100" value={point.soc} onChange={(event) => setCurve((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, soc: Number(event.target.value) } : item).sort((a, b) => a.soc - b.soc))} />%</span><span>功率 <input type="number" inputMode="decimal" min="0" max="1500" value={point.powerKw} onChange={(event) => updateCurvePower(index, Number(event.target.value))} />kW</span><button aria-label={`删除 SOC ${point.soc}% 控制点`} onClick={() => setCurve((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button></label>)}<button onClick={() => setCurve((current) => [...current, { soc: 50, powerKw: selectedVehicleModel.chargingClass === "flash_capable" ? 900 : 400 }].sort((a, b) => a.soc - b.soc))}>＋ 增加控制点</button></div>
          </div>}
          {tab === "参考 · 参数来源" && <div className="tab-content sources"><div className="source-intro"><h3>公开参数与模型假设分离</h3><p>{sourceNote}。所有分配算法与换车时长均作为研究模型，不声称拥有厂商完整 BMS 或站控策略。</p></div><table><thead><tr><th>参数</th><th>默认值</th><th>来源分类</th><th>可信度 / 说明</th></tr></thead><tbody><tr><td data-label="参数">单枪最大功率</td><td data-label="默认值">1500kW</td><td data-label="来源分类"><span className="source-tag official">官方公开参数</span></td><td data-label="说明">设备能力上限，非持续承诺</td></tr><tr><td data-label="参数">整桩双枪合计</td><td data-label="默认值">2100kW</td><td data-label="来源分类"><span className="source-tag media">公开媒体报道</span></td><td data-label="说明">可修改的共享硬上限</td></tr><tr><td data-label="参数">A 枪面向兼容车辆</td><td data-label="默认值">true</td><td data-label="来源分类"><span className="source-tag case">公开站点案例</span></td><td data-label="说明">通用角色</td></tr><tr><td data-label="参数">B 枪闪充专用</td><td data-label="默认值">true</td><td data-label="来源分类"><span className="source-tag case">企业公开回复</span></td><td data-label="说明">严格专用模式</td></tr><tr><td data-label="参数">车位换车周转</td><td data-label="默认值">{config.turnoverSec ?? 60} 秒</td><td data-label="来源分类"><span className="source-tag model">模型默认假设</span></td><td data-label="说明">包含驶离、确认与下一车进位准备</td></tr><tr><td data-label="参数">闪充专枪优先算法</td><td data-label="默认值">{policyNames[config.pilePolicy]}</td><td data-label="来源分类"><span className="source-tag model">模型默认假设</span></td><td data-label="说明">不代表厂商控制算法</td></tr><tr><td data-label="参数">A 枪 480kW</td><td data-label="默认值">可选策略上限</td><td data-label="来源分类"><span className="source-tag case">特定落地案例</span></td><td data-label="说明">不修改硬件铭牌上限</td></tr></tbody></table></div>}
        </section>
        </div>
      </main>

      <div className="mobile-transport" role="group" aria-label="移动仿真控制">
        <button className="primary-action" onClick={toggleRunning}>{running ? "暂停" : "继续"}</button>
        <button className="secondary-action" onClick={() => setShowReset(true)}>重置</button>
        <label><span>速度</span><select aria-label="移动仿真速度" value={speed} onChange={(event) => changeSpeed(Number(event.target.value))}>{speedOptions.map((value) => <option value={value} key={value}>{value}×</option>)}</select></label>
      </div>

      <footer className="app-footer"><span>模型单位：功率 kW · 能量 kWh · 时间 s · SOC 0–100</span><span>随机种子 {config.randomSeed} · schema v{config.schemaVersion}</span><span>能量流符号：电网输入为正，储能放电为正 / 充电为负</span></footer>

      {showAdd && (() => { const manualModel = config.vehicleModels.find((m) => m.id === manualVehicleModelId) ?? config.vehicleModels[0]; const handleModelSwitch = (modelId: string) => { setManualVehicleModelId(modelId); const m = config.vehicleModels.find((x) => x.id === modelId); if (m) setManual((v) => ({ ...v, capacity: m.usableBatteryCapacityKWh, maxPower: m.chargingClass === "flash_capable" ? 1500 : 520 })); }; return <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowAdd(false)}><section className="modal" data-dialog-id="add-vehicle" role="dialog" aria-modal="true" aria-labelledby="add-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" aria-label="关闭手动添加车辆" onClick={() => setShowAdd(false)}>×</button><span>MANUAL ARRIVAL</span><h2 id="add-title">手动添加车辆</h2><label className="manual-model-select"><span>车型</span><select data-initial-focus title={manualModel?.name} value={manualVehicleModelId} onChange={(event) => handleModelSwitch(event.target.value)}>{config.vehicleModels.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.chargingClass === "flash_capable" ? "闪充" : "普通"}</option>)}</select></label><div className="form-grid"><label>添加数量（辆）<input type="number" inputMode="numeric" min="1" max="30" value={manual.quantity} onChange={(event) => setManual((value) => ({ ...value, quantity: Math.max(1, Math.min(30, Number(event.target.value) || 1)) }))} /></label><label>本次电池容量<input type="number" inputMode="decimal" value={manual.capacity} onChange={(event) => setManual((value) => ({ ...value, capacity: Number(event.target.value) }))} /><small>默认取自车型，仅影响本次</small></label><label>本次峰值功率<input type="number" inputMode="decimal" value={manual.maxPower} onChange={(event) => setManual((value) => ({ ...value, maxPower: Number(event.target.value) }))} /><small>kW · 仅影响本次</small></label><label>初始 SOC %<input type="number" inputMode="decimal" min="0" max="95" value={manual.initialSoc} onChange={(event) => setManual((value) => ({ ...value, initialSoc: Number(event.target.value) }))} /></label><label>目标 SOC %<input type="number" inputMode="decimal" min="1" max="100" value={manual.targetSoc} onChange={(event) => setManual((value) => ({ ...value, targetSoc: Number(event.target.value) }))} /></label></div><p className="assumption">批量车辆按相同参数到达；本次容量和峰值功率仅覆盖本次添加，不修改车型配置。</p><button className="primary-action modal-submit" onClick={addVehicle}>添加 {Math.max(1, Math.min(30, Math.round(manual.quantity)))} 辆{manualModel?.name ?? ""}并参与调度</button></section></div>; })()}
      {selectedLiveVehicle && <aside className="vehicle-drawer" data-dialog-id="vehicle-drawer" role="dialog" aria-modal="true" aria-label={`${selectedLiveVehicle.id} 车辆详情`}><button className="modal-close" data-initial-focus aria-label="关闭车辆详情" onClick={() => setSelectedVehicle(null)}>×</button><span>VEHICLE SESSION</span><h2>{selectedLiveVehicle.id}</h2><p className="drawer-subtitle">{selectedLiveVehicle.name} · {selectedLiveVehicle.chargingClass === "flash_capable" ? "闪充车型" : "普通车型"}</p><div className="drawer-soc"><div><span>当前 SOC</span><strong>{selectedLiveVehicle.currentSocPercent.toFixed(1)}%</strong></div><i><em style={{ width: `${selectedLiveVehicle.currentSocPercent}%` }} /></i><small>初始 {selectedLiveVehicle.initialSocPercent}% · 目标 {selectedLiveVehicle.targetSocPercent}%</small></div><dl><div><dt>车型</dt><dd>{selectedLiveVehicle.name}</dd></div><div><dt>类别</dt><dd>{selectedLiveVehicle.chargingClass === "flash_capable" ? "闪充车型" : "普通车型"}</dd></div><div><dt>电池容量</dt><dd>{selectedLiveVehicle.usableBatteryCapacityKWh} kWh</dd></div><div><dt>当前状态</dt><dd>{statusNames[selectedLiveVehicle.status]}</dd></div><div><dt>当前 / 请求功率</dt><dd>{Math.round(selectedLiveVehicle.actualPowerKw)} / {Math.round(selectedLiveVehicle.requestedPowerKw)} kW</dd></div><div><dt>可用枪口</dt><dd>{selectedLiveVehicle.chargingClass === "flash_capable" ? "A 通用、B 专用" : "仅 A 通用"}</dd></div><div><dt>当前分配</dt><dd>{selectedLiveVehicle.assignedConnectorId ?? "尚未分配"}</dd></div><div><dt>已充入电量</dt><dd>{selectedLiveVehicle.deliveredEnergyKWh.toFixed(2)} kWh</dd></div><div><dt>等待用时</dt><dd>{formatDuration(vehicleWaitDuration(selectedLiveVehicle, state.timeSec))}</dd></div><div><dt>充电用时</dt><dd>{selectedLiveVehicle.chargingStartedAtSec === undefined ? "—" : formatDuration(vehicleChargeDuration(selectedLiveVehicle, state.timeSec))}</dd></div><div><dt>预计剩余等待</dt><dd>{selectedLiveVehicle.status === "queued" && selectedEstimate ? formatDuration(selectedEstimate.expectedWaitSec) : "—"}</dd></div><div><dt>预计剩余充电</dt><dd>{selectedRemainingCharge > 0 ? formatDuration(selectedRemainingCharge) : "—"}</dd></div><div><dt>电池温度 / 健康度</dt><dd>{selectedLiveVehicle.batteryTemperatureC}°C / {selectedLiveVehicle.batteryHealthPercent}%</dd></div><div><dt>限功率原因</dt><dd>{selectedLiveVehicle.limitReasons.join("、")}</dd></div></dl>{selectedLiveVehicle.status === "queued" && selectedEstimate && <div className="estimate-box">{selectedEstimate.explanation.map((line) => <p key={line}>{line}</p>)}</div>}<h3>车辆时间线</h3><ol className="timeline">{selectedLiveVehicle.timeline.slice().reverse().map((item, index) => <li key={`${item.timeSec}-${index}`}><time>T+{formatTime(item.timeSec)}</time><strong>{statusNames[item.status]}</strong><span>{item.note}</span></li>)}</ol></aside>}
      {showHelp && <div className="modal-backdrop" onMouseDown={() => setShowHelp(false)}><section className="modal help-modal" data-dialog-id="help" role="dialog" aria-modal="true" aria-labelledby="help-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" data-initial-focus aria-label="关闭帮助" onClick={() => setShowHelp(false)}>×</button><span>QUICK GUIDE</span><h2 id="help-title">如何读懂这个站</h2><ol><li><strong>先看首屏曲线：</strong>左侧比较电网、储能与车辆功率，右侧查看储能电量和安全下限。</li><li><strong>模拟电网异常：</strong>在"电网与母线"中可断电、临时限功率或恢复供电；断电时由储能尽力支撑。</li><li><strong>手动调储能：</strong>拖动当前电量滑杆，或使用 20%、50%、80%、100% 快捷按钮。</li><li><strong>调整采样：</strong>点击右上角"采样 5s"按钮，在 1、5、10、30、60 秒间循环。</li><li><strong>读车旁倒计时：</strong>充电区显示预计剩余充电，等候区显示预计剩余等待。</li><li><strong>查看诊断：</strong>页面会解释电网异常、等待变长和功率降低的具体原因。</li></ol><p className="assumption">本工具用于技术演示与方案研究，不代表任何厂商官方控制策略。</p></section></div>}
      {showReset && <div className="modal-backdrop"><section className="modal confirm-modal" data-dialog-id="reset" role="alertdialog" aria-modal="true" aria-labelledby="reset-title"><span>RESET SCENARIO</span><h2 id="reset-title">确认重置为空站？</h2><p>所有车辆、队列、事件和运行指标将清空，仿真自动暂停；当前参数与固定随机种子保留。</p><div className="confirm-actions"><button data-initial-focus onClick={() => setShowReset(false)}>取消</button><button className="danger-button" onClick={() => reset()}>清空车辆并暂停</button></div></section></div>}
      {showNewModel && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowNewModel(false)}><section className="modal model-modal" data-dialog-id="new-model" role="dialog" aria-modal="true" aria-labelledby="new-model-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" aria-label="关闭新建车型" onClick={() => setShowNewModel(false)}>×</button><span>NEW VEHICLE MODEL</span><h2 id="new-model-title">新建车型</h2><div className="form-grid"><label>车型名称<input type="text" data-initial-focus maxLength={40} value={newModelDraft.name} onChange={(event) => { setNewModelDraft((v) => ({ ...v, name: event.target.value })); setNewModelError(""); }} onKeyDown={(event) => { if (event.key === "Enter") handleCreateModel(); }} placeholder="例如：干线闪充 600" /></label><label>车型类别<select value={newModelDraft.chargingClass} onChange={(event) => { const cls = event.target.value as VehicleChargingClass; setNewModelDraft((v) => ({ ...v, chargingClass: cls, capacity: cls === "flash_capable" ? DEFAULT_FLASH_CAPACITY_KWH : DEFAULT_STANDARD_CAPACITY_KWH })); }}><option value="flash_capable">闪充车型</option><option value="standard_dc">普通车型</option></select></label><label>电池容量<input type="number" inputMode="decimal" min={CAPACITY_MIN_KWH} max={CAPACITY_MAX_KWH} step={1} value={newModelDraft.capacity} onChange={(event) => setNewModelDraft((v) => ({ ...v, capacity: Number(event.target.value) }))} /><small>kWh</small></label></div>{newModelError && <p className="field-error">{newModelError}</p>}<p className="assumption">创建后可继续调整充电曲线。</p><div className="confirm-actions"><button onClick={() => setShowNewModel(false)}>取消</button><button className="primary-action" onClick={handleCreateModel}>创建车型</button></div></section></div>}
      {showRenameModel && selectedVehicleModel && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowRenameModel(false)}><section className="modal model-modal" data-dialog-id="rename-model" role="dialog" aria-modal="true" aria-labelledby="rename-model-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" aria-label="关闭重命名车型" onClick={() => setShowRenameModel(false)}>×</button><span>RENAME MODEL</span><h2 id="rename-model-title">重命名车型</h2><div className="form-grid"><label>车型名称<input type="text" data-initial-focus maxLength={40} value={renameDraft} onChange={(event) => { setRenameDraft(event.target.value); setRenameError(""); }} onKeyDown={(event) => { if (event.key === "Enter") handleRenameModel(); }} /></label></div>{renameError && <p className="field-error">{renameError}</p>}<div className="confirm-actions"><button onClick={() => setShowRenameModel(false)}>取消</button><button className="primary-action" onClick={handleRenameModel}>保存</button></div></section></div>}
      {showDeleteModel && selectedVehicleModel && !isDefaultVehicleModel(selectedVehicleModel) && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowDeleteModel(false)}><section className="modal confirm-modal" data-dialog-id="delete-model" role="alertdialog" aria-modal="true" aria-labelledby="delete-model-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" aria-label="关闭删除车型" onClick={() => setShowDeleteModel(false)}>×</button><span>DELETE MODEL</span><h2 id="delete-model-title">删除车型</h2><p>确定删除"{selectedVehicleModel.name}"吗？</p><p className="assumption">已生成的车辆不会受到影响。删除后将无法再自动生成或手动添加该车型。</p><div className="confirm-actions"><button data-initial-focus onClick={() => setShowDeleteModel(false)}>取消</button><button className="danger-button" onClick={handleDeleteModel}>删除车型</button></div></section></div>}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
