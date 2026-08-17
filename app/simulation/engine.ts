import { baseConfig, makeVehicle } from "./presets.js";
import type {
  AllocationResult,
  ChargingCurvePoint,
  ChargingPile,
  Connector,
  GridControlMode,
  HistorySample,
  PilePowerAllocationPolicy,
  SimulationConfig,
  SimulationEvent,
  SimulationEventType,
  SimulationState,
  Vehicle,
  VehicleModel,
  WaitEstimate,
} from "./types.js";
import { resolveVehicleModels, type SimulationRuntimeConfig } from "./vehicle-models.js";

const EPSILON = 0.001;

export function interpolateCurve(points: ChargingCurvePoint[], soc: number): number {
  const sorted = [...points].sort((a, b) => a.soc - b.soc);
  if (!sorted.length) return 0;
  if (soc <= sorted[0].soc) return sorted[0].powerKw;
  if (soc >= sorted[sorted.length - 1].soc) return sorted[sorted.length - 1].powerKw;
  const upperIndex = sorted.findIndex((point) => point.soc >= soc);
  const lower = sorted[upperIndex - 1];
  const upper = sorted[upperIndex];
  const ratio = (soc - lower.soc) / Math.max(EPSILON, upper.soc - lower.soc);
  return lower.powerKw + (upper.powerKw - lower.powerKw) * ratio;
}

export function vehicleRequestedPower(vehicle: Vehicle): number {
  const curve = interpolateCurve(vehicle.chargingCurve, vehicle.currentSocPercent);
  const voltageCurrent = (vehicle.maxChargingVoltageV * vehicle.maxChargingCurrentA) / 1000;
  const temperatureFactor = vehicle.batteryTemperatureC < 0 ? 0.55 : vehicle.batteryTemperatureC > 43 ? 0.72 : 1;
  const healthFactor = Math.max(0.65, vehicle.batteryHealthPercent / 100);
  return Math.max(0, Math.min(curve, vehicle.maxChargingPowerKw, voltageCurrent, vehicle.maxChargingPowerKw * temperatureFactor * healthFactor));
}

export function isVehicleEligibleForConnector(vehicle: Vehicle, connector: Connector): boolean {
  if (!connector.enabled || vehicle.connectorStandard !== "gbt_dc") return false;
  if (connector.role === "universal") return true;
  return vehicle.chargingClass === "flash_capable";
}

function fairAllocate(requestA: number, requestB: number, available: number): [number, number] {
  const lowA = Math.min(requestA, available / 2);
  const lowB = Math.min(requestB, available / 2);
  let a = lowA;
  let b = lowB;
  let remaining = Math.max(0, available - a - b);
  const needA = Math.max(0, requestA - a);
  const addA = Math.min(needA, remaining);
  a += addA;
  remaining -= addA;
  b += Math.min(Math.max(0, requestB - b), remaining);
  return [a, b];
}

export function allocatePilePower(
  requestedA: number,
  requestedB: number,
  pileMaxPowerKw: number,
  policy: PilePowerAllocationPolicy,
  weights: [number, number] = [1, 1],
): AllocationResult {
  const aRequest = Math.max(0, requestedA);
  const bRequest = Math.max(0, requestedB);
  const available = Math.max(0, pileMaxPowerKw);
  let universalKw = 0;
  let dedicatedKw = 0;
  if (aRequest + bRequest <= available) {
    universalKw = aRequest;
    dedicatedKw = bRequest;
  } else if (policy === "dedicated_first") {
    dedicatedKw = Math.min(bRequest, available);
    universalKw = Math.min(aRequest, available - dedicatedKw);
  } else if (policy === "universal_first") {
    universalKw = Math.min(aRequest, available);
    dedicatedKw = Math.min(bRequest, available - universalKw);
  } else if (policy === "proportional_to_request") {
    const total = aRequest + bRequest;
    universalKw = Math.min(aRequest, available * (aRequest / total));
    dedicatedKw = Math.min(bRequest, available - universalKw);
  } else if (policy === "custom_weighted") {
    const totalWeight = Math.max(EPSILON, weights[0] + weights[1]);
    universalKw = Math.min(aRequest, available * (weights[0] / totalWeight));
    dedicatedKw = Math.min(bRequest, available - universalKw);
    const remaining = available - universalKw - dedicatedKw;
    if (remaining > 0) {
      const addA = Math.min(aRequest - universalKw, remaining);
      universalKw += addA;
      dedicatedKw += Math.min(bRequest - dedicatedKw, remaining - addA);
    }
  } else {
    [universalKw, dedicatedKw] = fairAllocate(aRequest, bRequest, available);
  }
  return {
    universalKw: Math.max(0, universalKw),
    dedicatedKw: Math.max(0, dedicatedKw),
    limited: universalKw + dedicatedKw + EPSILON < aRequest + bRequest,
  };
}

function connector(role: "universal" | "flash_dedicated", config: SimulationRuntimeConfig): Connector {
  const suffix = role === "universal" ? "A" : "B";
  return {
    id: `P1-${suffix}`,
    pileId: "P1",
    displayName: role === "universal" ? "A 通用枪" : "B 闪充专用枪",
    role,
    maxPowerKw: config.connectorMaxPowerKw,
    maxVoltageV: 1000,
    maxCurrentA: 1500,
    enabled: true,
    strictEligibility: true,
    policyPowerCapKw: role === "universal" ? config.universalPolicyCapKw : undefined,
    turnoverRemainingSec: 0,
    actualPowerKw: 0,
    requestedPowerKw: 0,
    busySec: 0,
    incompatibleIdleSec: 0,
    servedFlash: 0,
    servedStandard: 0,
  };
}

export function createInitialState(config: SimulationRuntimeConfig = baseConfig): SimulationState {
  const models = resolveVehicleModels(config);
  const flashModel = models.find((m) => m.chargingClass === "flash_capable")!;
  const standardModel = models.find((m) => m.chargingClass === "standard_dc")!;
  const vehicles = [
    makeVehicle("F-001", flashModel, 0, 18),
    makeVehicle("S-001", standardModel, 0, 31),
    makeVehicle("S-002", standardModel, 12, 22),
    makeVehicle("F-002", flashModel, 35, 42),
  ];
  vehicles.forEach((vehicle) => { vehicle.maxAcceptableWaitSec = config.maxAcceptableWaitSec ?? null; });
  const pile: ChargingPile = {
    id: "P1",
    name: "01# 滑轨悬吊双枪桩",
    aggregateMaxPowerKw: config.pileAggregateMaxPowerKw,
    enabled: true,
    allocationPolicy: config.pilePolicy,
    universalWeight: 1,
    flashDedicatedWeight: 1,
    conversionEfficiency: 0.96,
    connectors: [connector("universal", config), connector("flash_dedicated", config)],
    aggregateLimitedSec: 0,
    simultaneousSec: 0,
    curtailedEnergyKWh: 0,
  };
  const state: SimulationState = {
    timeSec: 0,
    vehicles,
    queue: ["F-001", "S-001"],
    piles: [pile],
    storage: {
      name: "储能柜 A+B",
      capacityKWh: config.storageCapacityKWh,
      energyKWh: config.storageCapacityKWh * config.storageInitialSocPercent / 100,
      minSocPercent: config.storageMinSocPercent,
      maxSocPercent: 95,
      maxChargePowerKw: config.storageMaxChargePowerKw,
      maxDischargePowerKw: config.storageMaxDischargePowerKw,
      chargeEfficiency: 0.95,
      dischargeEfficiency: 0.94,
      powerKw: 0,
      cumulativeChargeKWh: 0,
      cumulativeDischargeKWh: 0,
    },
    gridControl: {
      mode: "normal",
      temporaryLimitKw: Math.min(500, config.gridMaxPowerKw),
    },
    gridPowerKw: 0,
    chargingPowerKw: 0,
    cumulativeGridImportEnergyKWh: 0,
    cumulativeRatedGridCapacityEnergyKWh: 0,
    cumulativeAvailableGridCapacityEnergyKWh: 0,
    hasGridDisturbanceOccurred: false,
    randomState: config.randomSeed || 1,
    nextAutoArrivalSec: Math.max(15, 3600 / Math.max(1, config.arrivalRatePerHour)),
    events: [],
    history: [],
    totalArrivals: 2,
    invariantErrors: [],
  };
  return dispatchVehicles(state, config);
}

export function createEmptyState(config: SimulationRuntimeConfig = baseConfig): SimulationState {
  const state = createInitialState(config);
  state.vehicles = [];
  state.queue = [];
  state.events = [];
  state.history = [];
  state.totalArrivals = 0;
  for (const pile of state.piles) {
    pile.aggregateLimitedSec = 0;
    pile.simultaneousSec = 0;
    pile.curtailedEnergyKWh = 0;
    for (const target of pile.connectors) {
      target.currentVehicleId = undefined;
      target.sessionId = undefined;
      target.turnoverRemainingSec = 0;
      target.actualPowerKw = 0;
      target.requestedPowerKw = 0;
      target.busySec = 0;
      target.incompatibleIdleSec = 0;
      target.servedFlash = 0;
      target.servedStandard = 0;
    }
  }
  return state;
}

function addEvent(state: SimulationState, type: SimulationEventType, message: string, level: SimulationEvent["level"] = "info") {
  state.events.unshift({ id: `${state.timeSec}-${type}-${state.events.length}`, timeSec: state.timeSec, type, message, level });
  state.events = state.events.slice(0, 240);
}

export function getEffectiveGridLimit(state: SimulationState, config: SimulationRuntimeConfig): number {
  if (state.gridControl.mode === "outage") return 0;
  if (state.gridControl.mode === "limited") return Math.max(0, Math.min(config.gridMaxPowerKw, state.gridControl.temporaryLimitKw));
  return Math.max(0, config.gridMaxPowerKw);
}

export function getGridRatedCapacityUtilizationPercent(state: SimulationState): number | null {
  const ratedCapacityEnergyKWh = state.cumulativeRatedGridCapacityEnergyKWh ?? 0;
  if (ratedCapacityEnergyKWh <= EPSILON) return null;
  return (state.cumulativeGridImportEnergyKWh ?? 0) / ratedCapacityEnergyKWh * 100;
}

export function getGridAvailableCapacityUtilizationPercent(state: SimulationState): number | null {
  const availableCapacityEnergyKWh = state.cumulativeAvailableGridCapacityEnergyKWh ?? 0;
  if (availableCapacityEnergyKWh <= EPSILON) return null;
  return (state.cumulativeGridImportEnergyKWh ?? 0) / availableCapacityEnergyKWh * 100;
}

export function setGridControl(input: SimulationState, mode: GridControlMode, temporaryLimitKw?: number): SimulationState {
  const state = structuredClone(input);
  const nextLimit = Math.max(0, Math.round(temporaryLimitKw ?? state.gridControl.temporaryLimitKw));
  state.gridControl = { mode, temporaryLimitKw: nextLimit };
  state.hasGridDisturbanceOccurred = Boolean(state.hasGridDisturbanceOccurred || mode === "limited" || mode === "outage");
  if (mode === "outage") addEvent(state, "grid_outage", "手动触发电网断电，站点切换为储能支撑", "warning");
  else if (mode === "limited") addEvent(state, "grid_limit_changed", `电网临时限功率设为 ${nextLimit}kW`, "warning");
  else addEvent(state, "grid_restored", "电网已恢复正常供电", "success");
  return state;
}

export function setStorageEnergy(input: SimulationState, energyKWh: number): SimulationState {
  const state = structuredClone(input);
  state.storage.energyKWh = Math.max(0, Math.min(state.storage.capacityKWh, energyKWh));
  state.storage.powerKw = 0;
  addEvent(state, "storage_energy_adjusted", `手动将储能电量调整为 ${state.storage.energyKWh.toFixed(1)}kWh`, "success");
  return state;
}

function transition(vehicle: Vehicle, status: Vehicle["status"], timeSec: number, note: string) {
  vehicle.status = status;
  vehicle.timeline.push({ timeSec, status, note });
}

function candidateForConnector(state: SimulationState, connector: Connector, excluded: Set<string>, config: SimulationRuntimeConfig): Vehicle | undefined {
  const candidates = state.queue
    .map((id) => state.vehicles.find((vehicle) => vehicle.id === id))
    .filter((vehicle): vehicle is Vehicle => Boolean(vehicle && vehicle.status === "queued" && !excluded.has(vehicle.id)))
    .filter((vehicle) => isVehicleEligibleForConnector(vehicle, connector));
  if (!candidates.length) return undefined;
  if (connector.role === "universal" && config.queuePolicy === "standard_priority_on_universal") {
    return candidates.find((vehicle) => vehicle.chargingClass === "standard_dc") ?? candidates[0];
  }
  if (config.queuePolicy === "flash_priority") {
    return candidates.find((vehicle) => vehicle.chargingClass === "flash_capable") ?? candidates[0];
  }
  if (config.queuePolicy === "lowest_soc_first") return [...candidates].sort((a, b) => a.currentSocPercent - b.currentSocPercent)[0];
  if (config.queuePolicy === "shortest_expected_session") {
    return [...candidates].sort((a, b) => ((a.targetSocPercent - a.currentSocPercent) * a.usableBatteryCapacityKWh / Math.max(1, a.maxChargingPowerKw)) - ((b.targetSocPercent - b.currentSocPercent) * b.usableBatteryCapacityKWh / Math.max(1, b.maxChargingPowerKw)))[0];
  }
  if (config.queuePolicy === "weighted_wait_time") {
    return [...candidates].sort((a, b) => ((b.queuedAtSec ?? 0) - state.timeSec) * b.priority - ((a.queuedAtSec ?? 0) - state.timeSec) * a.priority)[0];
  }
  return candidates[0];
}

export function dispatchVehicles(input: SimulationState, config: SimulationRuntimeConfig): SimulationState {
  const state = structuredClone(input);
  const free = state.piles.flatMap((pile) => pile.enabled ? pile.connectors.filter((item) => item.enabled && !item.currentVehicleId && item.turnoverRemainingSec <= 0) : []);
  const ordered = [...free].sort((a, b) => (a.role === b.role ? 0 : a.role === "flash_dedicated" ? -1 : 1));
  const selected = new Set<string>();
  const assignments: { connector: Connector; vehicle: Vehicle }[] = [];
  for (const target of ordered) {
    const candidate = candidateForConnector(state, target, selected, config);
    if (!candidate) continue;
    selected.add(candidate.id);
    assignments.push({ connector: target, vehicle: candidate });
  }
  for (const assignment of assignments) {
    const target = state.piles.flatMap((pile) => pile.connectors).find((item) => item.id === assignment.connector.id)!;
    const vehicle = state.vehicles.find((item) => item.id === assignment.vehicle.id)!;
    if (!isVehicleEligibleForConnector(vehicle, target)) {
      addEvent(state, "vehicle_ineligible_for_connector", `${vehicle.id} 与 ${target.displayName} 不兼容，已取消分配`, "warning");
      continue;
    }
    target.currentVehicleId = vehicle.id;
    target.sessionId = `${vehicle.id}-${state.timeSec}`;
    vehicle.assignedPileId = target.pileId;
    vehicle.assignedConnectorId = target.id;
    vehicle.assignedConnectorRole = target.role;
    vehicle.phaseRemainingSec = config.movementSec;
    transition(vehicle, "moving_to_bay", state.timeSec, `驶入 ${target.displayName} 车位`);
    state.queue = state.queue.filter((id) => id !== vehicle.id);
    const eventType = target.role === "universal" ? "vehicle_assigned_to_universal" : "vehicle_assigned_to_flash_dedicated";
    addEvent(state, eventType, `${vehicle.id} → ${target.displayName}`, "success");
    if (target.role === "universal" && vehicle.chargingClass === "flash_capable") {
      addEvent(state, "universal_connector_serving_flash_vehicle", `${vehicle.id} 正在兼容使用通用枪`, "warning");
    }
    if (vehicle.chargingClass === "flash_capable") target.servedFlash += 1;
    else target.servedStandard += 1;
  }
  return state;
}

function nextRandom(state: SimulationState): number {
  state.randomState = (Math.imul(1664525, state.randomState) + 1013904223) >>> 0;
  return state.randomState / 4294967296;
}

export function addAutomaticVehicle(state: SimulationState, config: SimulationRuntimeConfig) {
  const models = resolveVehicleModels(config);
  const count = state.vehicles.length + 1;
  const chargingClass = nextRandom(state) < (config as SimulationConfig).flashShare ? "flash_capable" : "standard_dc";
  const eligibleModels = models.filter((m) => m.chargingClass === chargingClass);
  const selectedModel = eligibleModels.length <= 1
    ? eligibleModels[0]
    : eligibleModels[Math.floor(nextRandom(state) * eligibleModels.length)];
  const prefix = chargingClass === "flash_capable" ? "F" : "S";
  const vehicle = makeVehicle(`${prefix}-${String(count).padStart(3, "0")}`, selectedModel, state.timeSec, 12 + Math.round(nextRandom(state) * 35));
  vehicle.maxAcceptableWaitSec = config.maxAcceptableWaitSec ?? null;
  const wantsFullCharge = nextRandom(state) < 0.28;
  const partialTarget = chargingClass === "flash_capable" ? 72 + nextRandom(state) * 24 : 78 + nextRandom(state) * 19;
  vehicle.targetSocPercent = wantsFullCharge ? 100 : Math.max(vehicle.currentSocPercent + 5, Math.round(partialTarget));
  vehicle.status = "queued";
  vehicle.queuedAtSec = state.timeSec;
  vehicle.timeline = [{ timeSec: state.timeSec, status: "queued", note: "自动到达并加入队列" }];
  state.vehicles.push(vehicle);
  state.queue.push(vehicle.id);
  state.totalArrivals += 1;
  addEvent(state, "vehicle_arrived", `${vehicle.id} 到达入口（${chargingClass === "flash_capable" ? "闪充兼容" : "普通直流"}）`);
  const mean = 3600 / Math.max(1, config.arrivalRatePerHour);
  const interval = Math.max(8, -Math.log(Math.max(0.001, 1 - nextRandom(state))) * mean);
  state.nextAutoArrivalSec = state.timeSec + interval;
}

function releaseVehicle(state: SimulationState, connector: Connector, vehicle: Vehicle, config: SimulationRuntimeConfig) {
  connector.currentVehicleId = undefined;
  connector.sessionId = undefined;
  connector.actualPowerKw = 0;
  connector.requestedPowerKw = 0;
  connector.turnoverRemainingSec = Math.max(0, config.turnoverSec ?? 60);
  vehicle.assignedConnectorId = undefined;
  vehicle.assignedConnectorRole = undefined;
  vehicle.assignedPileId = undefined;
  vehicle.phaseRemainingSec = 3;
  transition(vehicle, "departing", state.timeSec, "完成结算，驶离站点");
}

function progressPhases(state: SimulationState, config: SimulationRuntimeConfig) {
  for (const target of state.piles.flatMap((pile) => pile.connectors)) {
    target.turnoverRemainingSec = Math.max(0, target.turnoverRemainingSec - 1);
  }
  for (const vehicle of state.vehicles) {
    if (vehicle.status === "scheduled" && vehicle.arrivalTimeSec <= state.timeSec) {
      vehicle.queuedAtSec = state.timeSec;
      transition(vehicle, "queued", state.timeSec, "到达并加入全局等待队列");
      state.queue.push(vehicle.id);
      state.totalArrivals += 1;
      addEvent(state, "vehicle_queued", `${vehicle.id} 进入等待队列`);
    } else if (["moving_to_bay", "connecting", "disconnecting", "departing"].includes(vehicle.status)) {
      vehicle.phaseRemainingSec -= 1;
      if (vehicle.phaseRemainingSec > 0) continue;
      if (vehicle.status === "moving_to_bay") {
        vehicle.phaseRemainingSec = config.handshakeSec;
        transition(vehicle, "connecting", state.timeSec, "插枪并进行通信握手");
      } else if (vehicle.status === "connecting") {
        vehicle.chargingStartedAtSec = state.timeSec;
        transition(vehicle, "charging", state.timeSec, "握手完成，开始充电");
        addEvent(state, "charging_started", `${vehicle.id} 开始充电`, "success");
      } else if (vehicle.status === "disconnecting") {
        const target = state.piles.flatMap((pile) => pile.connectors).find((item) => item.currentVehicleId === vehicle.id);
        if (target) releaseVehicle(state, target, vehicle, config);
      } else if (vehicle.status === "departing") {
        vehicle.departedAtSec = state.timeSec;
        transition(vehicle, "departed", state.timeSec, "已离场");
        addEvent(state, "vehicle_departed", `${vehicle.id} 已离场`, "success");
      }
    }
  }
  for (const id of [...state.queue]) {
    const vehicle = state.vehicles.find((item) => item.id === id);
    if (vehicle?.queuedAtSec !== undefined && config.maxAcceptableWaitSec !== null && state.timeSec - vehicle.queuedAtSec > config.maxAcceptableWaitSec) {
      transition(vehicle, "abandoned", state.timeSec, "超过最大可接受等待时间，弃队");
      state.queue = state.queue.filter((item) => item !== id);
      addEvent(state, "vehicle_abandoned", `${vehicle.id} 等待超时后弃队`, "warning");
    }
  }
}

function storageAvailableDischarge(state: SimulationState): number {
  const minEnergy = state.storage.capacityKWh * state.storage.minSocPercent / 100;
  const usableThisSecond = Math.max(0, (state.storage.energyKWh - minEnergy) * 3600 * state.storage.dischargeEfficiency);
  return Math.min(state.storage.maxDischargePowerKw, usableThisSecond);
}

function allocateCharging(state: SimulationState, config: SimulationRuntimeConfig) {
  const gridLimit = getEffectiveGridLimit(state, config);
  const stationAvailable = Math.max(0, Math.min(config.stationBusMaxPowerKw, gridLimit - config.baseLoadKw + storageAvailableDischarge(state)));
  let remaining = stationAvailable;
  state.chargingPowerKw = 0;
  for (const pile of state.piles) {
    pile.aggregateMaxPowerKw = config.pileAggregateMaxPowerKw;
    pile.allocationPolicy = config.pilePolicy;
    const a = pile.connectors.find((item) => item.role === "universal")!;
    const b = pile.connectors.find((item) => item.role === "flash_dedicated")!;
    a.maxPowerKw = config.connectorMaxPowerKw;
    b.maxPowerKw = config.connectorMaxPowerKw;
    a.policyPowerCapKw = config.universalPolicyCapKw;
    const vehicleA = state.vehicles.find((item) => item.id === a.currentVehicleId && item.status === "charging");
    const vehicleB = state.vehicles.find((item) => item.id === b.currentVehicleId && item.status === "charging");
    const request = (vehicle: Vehicle | undefined, target: Connector) => vehicle ? Math.min(vehicleRequestedPower(vehicle), target.maxPowerKw, target.policyPowerCapKw ?? Number.POSITIVE_INFINITY) : 0;
    const requestedA = request(vehicleA, a);
    const requestedB = request(vehicleB, b);
    a.requestedPowerKw = requestedA;
    b.requestedPowerKw = requestedB;
    if (vehicleA) vehicleA.requestedPowerKw = requestedA;
    if (vehicleB) vehicleB.requestedPowerKw = requestedB;
    const pileAvailable = Math.min(pile.aggregateMaxPowerKw, remaining);
    const allocated = allocatePilePower(requestedA, requestedB, pileAvailable, pile.allocationPolicy, [pile.universalWeight, pile.flashDedicatedWeight]);
    a.actualPowerKw = Math.min(a.maxPowerKw, allocated.universalKw);
    b.actualPowerKw = Math.min(b.maxPowerKw, allocated.dedicatedKw);
    if (vehicleA) {
      vehicleA.actualPowerKw = a.actualPowerKw;
      vehicleA.limitReasons = a.actualPowerKw + EPSILON < requestedA ? [pileAvailable < pile.aggregateMaxPowerKw ? "station_power_limit" : "pile_aggregate_limit", "pile_allocation_policy"] : ["none"];
    }
    if (vehicleB) {
      vehicleB.actualPowerKw = b.actualPowerKw;
      vehicleB.limitReasons = b.actualPowerKw + EPSILON < requestedB ? [pileAvailable < pile.aggregateMaxPowerKw ? "station_power_limit" : "pile_aggregate_limit", "pile_allocation_policy"] : ["none"];
    }
    const total = a.actualPowerKw + b.actualPowerKw;
    if (a.actualPowerKw > 0 && b.actualPowerKw > 0) pile.simultaneousSec += 1;
    if (allocated.limited && requestedA + requestedB > pile.aggregateMaxPowerKw) {
      pile.aggregateLimitedSec += 1;
      pile.curtailedEnergyKWh += Math.max(0, requestedA + requestedB - total) / 3600;
      if (state.timeSec % 30 === 0) addEvent(state, "pile_aggregate_power_limited", `${pile.name} 请求 ${Math.round(requestedA + requestedB)}kW，受 2100kW 整桩上限约束`, "warning");
    }
    remaining -= total;
    state.chargingPowerKw += total;
  }
}

function updateEnergy(state: SimulationState, config: SimulationRuntimeConfig) {
  for (const target of state.piles.flatMap((pile) => pile.connectors)) {
    if (target.currentVehicleId) target.busySec += 1;
    const vehicle = state.vehicles.find((item) => item.id === target.currentVehicleId && item.status === "charging");
    if (!vehicle) continue;
    const delta = target.actualPowerKw * vehicle.chargingEfficiency / 3600;
    vehicle.deliveredEnergyKWh += delta;
    vehicle.currentSocPercent = Math.min(vehicle.targetSocPercent, vehicle.currentSocPercent + delta / vehicle.usableBatteryCapacityKWh * 100);
    if (vehicle.currentSocPercent + EPSILON >= vehicle.targetSocPercent) {
      vehicle.currentSocPercent = vehicle.targetSocPercent;
      vehicle.actualPowerKw = 0;
      vehicle.completedAtSec = state.timeSec;
      vehicle.phaseRemainingSec = config.disconnectSec;
      transition(vehicle, "disconnecting", state.timeSec, "达到目标 SOC，拔枪结算");
      addEvent(state, "charging_completed", `${vehicle.id} 达到 ${vehicle.targetSocPercent}% 目标 SOC`, "success");
    }
  }
  const load = state.chargingPowerKw + config.baseLoadKw;
  const gridLimit = getEffectiveGridLimit(state, config);
  const deficit = Math.max(0, load - gridLimit);
  const discharge = Math.min(deficit, storageAvailableDischarge(state));
  const spareGrid = Math.max(0, gridLimit - load);
  const maxEnergy = state.storage.capacityKWh * state.storage.maxSocPercent / 100;
  const roomPower = Math.max(0, (maxEnergy - state.storage.energyKWh) * 3600 / state.storage.chargeEfficiency);
  const charge = Math.min(spareGrid, state.storage.maxChargePowerKw, roomPower);
  state.storage.powerKw = discharge - charge;
  if (discharge > 0) {
    const energy = discharge / state.storage.dischargeEfficiency / 3600;
    state.storage.energyKWh -= energy;
    state.storage.cumulativeDischargeKWh += energy;
  } else if (charge > 0) {
    const energy = charge * state.storage.chargeEfficiency / 3600;
    state.storage.energyKWh += energy;
    state.storage.cumulativeChargeKWh += energy;
  }
  state.gridPowerKw = Math.max(0, Math.min(gridLimit, load - discharge + charge));
}

function updateGridEnergyStatistics(state: SimulationState, config: SimulationRuntimeConfig) {
  state.cumulativeGridImportEnergyKWh = (state.cumulativeGridImportEnergyKWh ?? 0) + Math.max(0, state.gridPowerKw) / 3600;
  state.cumulativeRatedGridCapacityEnergyKWh = (state.cumulativeRatedGridCapacityEnergyKWh ?? 0) + Math.max(0, config.gridMaxPowerKw) / 3600;
  state.cumulativeAvailableGridCapacityEnergyKWh = (state.cumulativeAvailableGridCapacityEnergyKWh ?? 0) + getEffectiveGridLimit(state, config) / 3600;
}

function updateIncompatibleIdle(state: SimulationState) {
  const standardWaiting = state.queue.some((id) => state.vehicles.find((vehicle) => vehicle.id === id)?.chargingClass === "standard_dc");
  for (const target of state.piles.flatMap((pile) => pile.connectors)) {
    if (target.role === "flash_dedicated" && !target.currentVehicleId && standardWaiting) {
      target.incompatibleIdleSec += 1;
      if (state.timeSec % 45 === 0) addEvent(state, "dedicated_connector_idle_no_eligible_vehicle", `${target.displayName} 空闲，但队列中的普通车辆不兼容`, "warning");
    }
  }
}

function sampleHistory(state: SimulationState, config: SimulationRuntimeConfig) {
  const interval = Math.max(1, Math.round(config.historySampleSec ?? 5));
  if (state.timeSec % interval !== 0) return;
  const connectors = state.piles.flatMap((pile) => pile.connectors);
  const sample: HistorySample = {
    timeSec: state.timeSec,
    chargingPowerKw: state.chargingPowerKw,
    gridPowerKw: state.gridPowerKw,
    storagePowerKw: state.storage.powerKw,
    storageSocPercent: state.storage.energyKWh / state.storage.capacityKWh * 100,
    storageEnergyKWh: state.storage.energyKWh,
    queueLength: state.queue.length,
    chargingCount: state.vehicles.filter((vehicle) => vehicle.status === "charging").length,
    powerA: connectors.find((item) => item.role === "universal")?.actualPowerKw ?? 0,
    powerB: connectors.find((item) => item.role === "flash_dedicated")?.actualPowerKw ?? 0,
  };
  state.history.push(sample);
  state.history = state.history.slice(-Math.max(2, Math.ceil(7200 / interval)));
}

export function assertSimulationInvariants(state: SimulationState, config: SimulationRuntimeConfig): void {
  const errors: string[] = [];
  const occupiedVehicles = new Set<string>();
  for (const pile of state.piles) {
    const universal = pile.connectors.filter((item) => item.role === "universal");
    const dedicated = pile.connectors.filter((item) => item.role === "flash_dedicated");
    if (universal.length !== 1 || dedicated.length !== 1) errors.push(`${pile.id} 的 A/B 枪拓扑不合法`);
    const sum = pile.connectors.reduce((total, item) => total + item.actualPowerKw, 0);
    if (sum > config.pileAggregateMaxPowerKw + EPSILON) errors.push(`${pile.id} 超过整桩上限`);
    for (const target of pile.connectors) {
      if (target.actualPowerKw > config.connectorMaxPowerKw + EPSILON) errors.push(`${target.id} 超过单枪上限`);
      if (!target.currentVehicleId) continue;
      if (occupiedVehicles.has(target.currentVehicleId)) errors.push(`${target.currentVehicleId} 被重复分配`);
      occupiedVehicles.add(target.currentVehicleId);
      const vehicle = state.vehicles.find((item) => item.id === target.currentVehicleId);
      if (!vehicle || vehicle.assignedConnectorId !== target.id) errors.push(`${target.id} 与车辆双向引用不一致`);
      if (vehicle && !isVehicleEligibleForConnector(vehicle, target)) errors.push(`${vehicle.id} 被分配到不兼容枪口`);
      if (state.queue.includes(target.currentVehicleId)) errors.push(`${target.currentVehicleId} 已分配但仍在队列`);
    }
  }
  for (const vehicle of state.vehicles) {
    if (vehicle.currentSocPercent > vehicle.targetSocPercent + EPSILON) errors.push(`${vehicle.id} SOC 超过目标`);
    if (vehicle.currentSocPercent + EPSILON < vehicle.initialSocPercent) errors.push(`${vehicle.id} SOC 异常下降`);
    if (vehicle.actualPowerKw > vehicle.requestedPowerKw + EPSILON) errors.push(`${vehicle.id} 实际功率超过请求`);
  }
  if (errors.length) throw new Error(errors.join("；"));
}

function stepOne(input: SimulationState, config: SimulationRuntimeConfig): SimulationState {
  let state = structuredClone(input);
  state.timeSec += 1;
  progressPhases(state, config);
  if (config.autoArrivalEnabled && state.timeSec >= state.nextAutoArrivalSec && state.vehicles.length < 500) addAutomaticVehicle(state, config);
  state = dispatchVehicles(state, config);
  allocateCharging(state, config);
  updateEnergy(state, config);
  updateGridEnergyStatistics(state, config);
  updateIncompatibleIdle(state);
  sampleHistory(state, config);
  try {
    assertSimulationInvariants(state, config);
    state.invariantErrors = [];
  } catch (error) {
    state.invariantErrors = [error instanceof Error ? error.message : "未知不变量错误"];
  }
  return state;
}

export function stepSimulation(input: SimulationState, config: SimulationRuntimeConfig, deltaTimeSec = 1): SimulationState {
  let state = input;
  for (let second = 0; second < Math.max(1, Math.floor(deltaTimeSec)); second += 1) state = stepOne(state, config);
  return state;
}

export function addManualVehicle(state: SimulationState, config: SimulationRuntimeConfig, input: { chargingClass: "flash_capable" | "standard_dc"; capacity: number; maxPower: number; initialSoc: number; targetSoc: number; vehicleModelId?: string }): SimulationState {
  const next = structuredClone(state);
  const models = resolveVehicleModels(config);
  let selectedModel: VehicleModel;
  if (input.vehicleModelId) {
    const found = models.find((m) => m.id === input.vehicleModelId);
    selectedModel = found ?? models.find((m) => m.chargingClass === input.chargingClass) ?? models[0];
  } else {
    selectedModel = models.find((m) => m.chargingClass === input.chargingClass) ?? models[0];
  }
  const vehicle = makeVehicle(`${selectedModel.chargingClass === "flash_capable" ? "F" : "S"}-M${String(next.vehicles.length + 1).padStart(2, "0")}`, selectedModel, next.timeSec, input.initialSoc);
  vehicle.usableBatteryCapacityKWh = input.capacity;
  vehicle.maxChargingPowerKw = input.maxPower;
  vehicle.targetSocPercent = input.targetSoc;
  vehicle.status = "queued";
  vehicle.queuedAtSec = next.timeSec;
  vehicle.timeline = [{ timeSec: next.timeSec, status: "queued", note: "手动添加并进入全局等待队列" }];
  next.vehicles.push(vehicle);
  next.queue.push(vehicle.id);
  next.totalArrivals += 1;
  addEvent(next, "vehicle_queued", `${vehicle.id} 已手动加入队列`, "success");
  return dispatchVehicles(next, config);
}

export function estimateRemainingChargeTime(vehicle: Vehicle): number {
  if (vehicle.currentSocPercent >= vehicle.targetSocPercent) return 0;
  const allocationFactor = vehicle.actualPowerKw > EPSILON && vehicle.requestedPowerKw > EPSILON
    ? Math.max(0.15, Math.min(1, vehicle.actualPowerKw / vehicle.requestedPowerKw))
    : 1;
  let seconds = 0;
  let soc = vehicle.currentSocPercent;
  while (soc < vehicle.targetSocPercent - EPSILON) {
    const nextSoc = Math.min(vehicle.targetSocPercent, soc + 0.5);
    const midpoint = (soc + nextSoc) / 2;
    const requested = vehicleRequestedPower({ ...vehicle, currentSocPercent: midpoint });
    const effectivePower = Math.max(20, requested * allocationFactor);
    const batteryEnergy = vehicle.usableBatteryCapacityKWh * (nextSoc - soc) / 100;
    seconds += batteryEnergy / Math.max(EPSILON, effectivePower * vehicle.chargingEfficiency) * 3600;
    soc = nextSoc;
  }
  return Math.min(24 * 3600, Math.max(0, seconds));
}

function estimatedServiceSec(vehicle: Vehicle, config: SimulationRuntimeConfig): number {
  const turnover = Math.max(0, config.turnoverSec ?? 60);
  const charge = estimateRemainingChargeTime(vehicle);
  if (vehicle.status === "moving_to_bay") return vehicle.phaseRemainingSec + config.handshakeSec + charge + config.disconnectSec + turnover;
  if (vehicle.status === "connecting") return vehicle.phaseRemainingSec + charge + config.disconnectSec + turnover;
  if (vehicle.status === "charging") return charge + config.disconnectSec + turnover;
  if (vehicle.status === "disconnecting") return vehicle.phaseRemainingSec + turnover;
  return config.movementSec + config.handshakeSec + charge + config.disconnectSec + turnover;
}

function estimatedCandidate(candidates: Vehicle[], target: Connector, config: SimulationRuntimeConfig, timeSec: number): Vehicle | undefined {
  if (!candidates.length) return undefined;
  if (target.role === "universal" && config.queuePolicy === "standard_priority_on_universal") {
    return candidates.find((vehicle) => vehicle.chargingClass === "standard_dc") ?? candidates[0];
  }
  if (config.queuePolicy === "flash_priority") return candidates.find((vehicle) => vehicle.chargingClass === "flash_capable") ?? candidates[0];
  if (config.queuePolicy === "lowest_soc_first") return [...candidates].sort((a, b) => a.currentSocPercent - b.currentSocPercent)[0];
  if (config.queuePolicy === "shortest_expected_session") return [...candidates].sort((a, b) => estimatedServiceSec(a, config) - estimatedServiceSec(b, config))[0];
  if (config.queuePolicy === "weighted_wait_time") {
    return [...candidates].sort((a, b) => ((timeSec - (b.queuedAtSec ?? timeSec)) * b.priority) - ((timeSec - (a.queuedAtSec ?? timeSec)) * a.priority))[0];
  }
  return candidates[0];
}

export function estimateVehicleWaitTime(vehicleId: string, state: SimulationState, config: SimulationRuntimeConfig = baseConfig): WaitEstimate {
  const vehicle = state.vehicles.find((item) => item.id === vehicleId);
  if (!vehicle) return { expectedWaitSec: 0, confidence: "low", explanation: ["车辆不存在"] };
  if (vehicle.status !== "queued") {
    return {
      expectedWaitSec: 0,
      likelyConnectorId: vehicle.assignedConnectorId,
      confidence: "high",
      explanation: [vehicle.status === "charging" ? "车辆已开始充电。" : "车辆当前不在等待队列。"],
    };
  }

  const allConnectors = state.piles.flatMap((pile) => pile.connectors).filter((target) => target.enabled);
  const compatible = allConnectors.filter((target) => isVehicleEligibleForConnector(vehicle, target));
  const slots = allConnectors.map((target) => {
    const active = state.vehicles.find((item) => item.id === target.currentVehicleId);
    return {
      target,
      availableSec: active ? estimatedServiceSec(active, config) : Math.max(0, target.turnoverRemainingSec),
    };
  });
  const pending = state.queue
    .map((id) => state.vehicles.find((item) => item.id === id))
    .filter((item): item is Vehicle => Boolean(item?.status === "queued"));
  const queueIndex = Math.max(0, state.queue.indexOf(vehicleId));
  const aheadCompatible = state.queue.slice(0, queueIndex).filter((id) => {
    const item = state.vehicles.find((candidate) => candidate.id === id);
    return item && compatible.some((target) => isVehicleEligibleForConnector(item, target));
  }).length;

  for (let iteration = 0; iteration < 1000 && pending.length; iteration += 1) {
    const nextTime = Math.min(...slots.map((slot) => slot.availableSec));
    if (!Number.isFinite(nextTime)) break;
    const freeNow = slots
      .filter((slot) => slot.availableSec <= nextTime + EPSILON)
      .sort((a, b) => a.target.role === b.target.role ? 0 : a.target.role === "flash_dedicated" ? -1 : 1);
    let assigned = false;
    for (const slot of freeNow) {
      const candidates = pending.filter((item) => isVehicleEligibleForConnector(item, slot.target));
      const candidate = estimatedCandidate(candidates, slot.target, config, state.timeSec + nextTime);
      if (!candidate) {
        slot.availableSec = Number.POSITIVE_INFINITY;
        continue;
      }
      assigned = true;
      if (candidate.id === vehicleId) {
        const explanation = [
          vehicle.chargingClass === "standard_dc" ? "普通车辆仅可使用 A 通用枪。" : "闪充车辆可使用 A 通用枪或 B 闪充专用枪。",
          `前方有 ${aheadCompatible} 辆兼容车辆，预测已计入当前车辆剩余充电与 ${Math.round(config.turnoverSec ?? 60)} 秒换车时间。`,
        ];
        if (vehicle.chargingClass === "standard_dc") explanation.push("B 专用枪即使空闲也不计入本车服务能力。");
        return { expectedWaitSec: Math.max(0, nextTime), likelyConnectorId: slot.target.id, confidence: "medium", explanation };
      }
      pending.splice(pending.findIndex((item) => item.id === candidate.id), 1);
      slot.availableSec = nextTime + estimatedServiceSec(candidate, config);
    }
    if (!assigned && slots.every((slot) => !Number.isFinite(slot.availableSec))) break;
  }

  return {
    expectedWaitSec: config.maxAcceptableWaitSec ?? 24 * 3600,
    likelyConnectorId: compatible[0]?.id,
    confidence: "low",
    explanation: ["当前队列与枪口兼容条件下暂时无法确定服务时点。"],
  };
}

export function getConfigForScenario(name: string, partial: Partial<SimulationConfig>): SimulationConfig {
  return { ...baseConfig, ...partial, scenarioName: name };
}
