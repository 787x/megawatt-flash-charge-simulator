import type { ChargingCurvePoint, SimulationConfig, Vehicle, VehicleModel } from "./types.js";

export const flashCurve: ChargingCurvePoint[] = [
  { soc: 0, powerKw: 400 },
  { soc: 10, powerKw: 1000 },
  { soc: 20, powerKw: 1500 },
  { soc: 60, powerKw: 1300 },
  { soc: 80, powerKw: 800 },
  { soc: 95, powerKw: 250 },
  { soc: 100, powerKw: 0 },
];

export const standardCurve: ChargingCurvePoint[] = [
  { soc: 0, powerKw: 260 },
  { soc: 15, powerKw: 420 },
  { soc: 30, powerKw: 520 },
  { soc: 55, powerKw: 470 },
  { soc: 80, powerKw: 240 },
  { soc: 95, powerKw: 70 },
  { soc: 100, powerKw: 0 },
];

export const baseConfig: SimulationConfig = {
  schemaVersion: 2,
  scenarioName: "标准双枪闪充桩",
  gridMaxPowerKw: 1450,
  baseLoadKw: 45,
  stationBusMaxPowerKw: 2200,
  pileAggregateMaxPowerKw: 2100,
  connectorMaxPowerKw: 1500,
  flashChargingCurve: flashCurve.map((point) => ({ ...point })),
  standardChargingCurve: standardCurve.map((point) => ({ ...point })),
  storageCapacityKWh: 380,
  storageInitialSocPercent: 76,
  storageMinSocPercent: 15,
  storageMaxDischargePowerKw: 900,
  storageMaxChargePowerKw: 600,
  queuePolicy: "role_aware_fcfs",
  maxAcceptableWaitSec: 30 * 60,
  pilePolicy: "dedicated_first",
  autoArrivalEnabled: true,
  arrivalRatePerHour: 16,
  flashShare: 0.35,
  randomSeed: 20260723,
  handshakeSec: 5,
  movementSec: 4,
  disconnectSec: 5,
  turnoverSec: 60,
  historySampleSec: 5,
};

export const scenarioPresets: Record<string, Partial<SimulationConfig>> = {
  "标准双枪闪充桩": {},
  "闪充车占比高": { flashShare: 0.78, arrivalRatePerHour: 22 },
  "普通车拥堵": {
    flashShare: 0.1,
    arrivalRatePerHour: 28,
    queuePolicy: "standard_priority_on_universal",
  },
  "混合高峰": { flashShare: 0.45, arrivalRatePerHour: 34 },
  "电网限容": { gridMaxPowerKw: 800, storageInitialSocPercent: 32 },
  "通用枪案例上限": { universalPolicyCapKw: 480, flashShare: 0.35 },
};

export function makeVehicle(
  id: string,
  model: VehicleModel,
  arrivalTimeSec: number,
  soc?: number,
): Vehicle {
  const isFlash = model.chargingClass === "flash_capable";
  const initialSoc = soc ?? (isFlash ? 18 : 27);
  return {
    id,
    vehicleModelId: model.id,
    name: model.name,
    chargingClass: model.chargingClass,
    status: arrivalTimeSec > 0 ? "scheduled" : "queued",
    usableBatteryCapacityKWh: model.usableBatteryCapacityKWh,
    initialSocPercent: initialSoc,
    currentSocPercent: initialSoc,
    targetSocPercent: isFlash ? 82 : 88,
    maxChargingPowerKw: isFlash ? 1500 : 520,
    maxChargingVoltageV: isFlash ? 1000 : 800,
    maxChargingCurrentA: isFlash ? 1500 : 650,
    chargingEfficiency: 0.94,
    batteryTemperatureC: 27,
    batteryHealthPercent: 96,
    chargingCurve: model.chargingCurve.map((point) => ({ ...point })),
    arrivalTimeSec,
    queuedAtSec: arrivalTimeSec <= 0 ? 0 : undefined,
    maxAcceptableWaitSec: 30 * 60,
    priority: 1,
    connectorStandard: "gbt_dc",
    requestedPowerKw: 0,
    actualPowerKw: 0,
    deliveredEnergyKWh: 0,
    limitReasons: ["none"],
    phaseRemainingSec: 0,
    timeline: arrivalTimeSec <= 0 ? [{ timeSec: 0, status: "queued", note: "进入全局等待队列" }] : [],
  };
}
