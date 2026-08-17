import { flashCurve, standardCurve } from "./presets.js";
import type {
  ChargingCurvePoint,
  SimulationConfig,
  VehicleChargingClass,
  VehicleModel,
} from "./types.js";

export const DEFAULT_FLASH_MODEL_ID = "default-flash";
export const DEFAULT_STANDARD_MODEL_ID = "default-standard";

export const DEFAULT_FLASH_CAPACITY_KWH = 112;
export const DEFAULT_STANDARD_CAPACITY_KWH = 76;

const VEHICLE_MODEL_NAME_MAX_LENGTH = 40;
const CAPACITY_MIN_KWH = 20;
const CAPACITY_MAX_KWH = 2000;

let idCounter = 0;

export function createVehicleModelId(): string {
  idCounter += 1;
  return `vm-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function cloneChargingCurve(points: ChargingCurvePoint[]): ChargingCurvePoint[] {
  return points.map((point) => ({ ...point }));
}

export function cloneDefaultChargingCurve(chargingClass: VehicleChargingClass): ChargingCurvePoint[] {
  return chargingClass === "flash_capable"
    ? cloneChargingCurve(flashCurve)
    : cloneChargingCurve(standardCurve);
}

export function cloneVehicleModel(model: VehicleModel): VehicleModel {
  return {
    ...model,
    chargingCurve: cloneChargingCurve(model.chargingCurve),
  };
}

export function cloneVehicleModels(models: VehicleModel[]): VehicleModel[] {
  return models.map(cloneVehicleModel);
}

export const defaultVehicleModels: VehicleModel[] = [
  {
    id: DEFAULT_FLASH_MODEL_ID,
    name: "兆瓦闪充车辆",
    chargingClass: "flash_capable",
    usableBatteryCapacityKWh: DEFAULT_FLASH_CAPACITY_KWH,
    chargingCurve: cloneDefaultChargingCurve("flash_capable"),
  },
  {
    id: DEFAULT_STANDARD_MODEL_ID,
    name: "普通直流快充车辆",
    chargingClass: "standard_dc",
    usableBatteryCapacityKWh: DEFAULT_STANDARD_CAPACITY_KWH,
    chargingCurve: cloneDefaultChargingCurve("standard_dc"),
  },
];

function isValidCurve(points: ChargingCurvePoint[]): boolean {
  if (!Array.isArray(points) || points.length < 2) return false;
  for (const point of points) {
    if (typeof point.soc !== "number" || !Number.isFinite(point.soc)) return false;
    if (typeof point.powerKw !== "number" || !Number.isFinite(point.powerKw)) return false;
    if (point.soc < 0 || point.soc > 100) return false;
    if (point.powerKw < 0) return false;
  }
  for (let i = 1; i < points.length; i++) {
    if (points[i].soc <= points[i - 1].soc) return false;
  }
  return true;
}

export interface VehicleModelValidationError {
  type:
    | "missing_flash_model"
    | "missing_standard_model"
    | "duplicate_id"
    | "duplicate_name"
    | "empty_name"
    | "name_too_long"
    | "invalid_capacity"
    | "invalid_curve";
  message: string;
  modelId?: string;
}

export function validateVehicleModels(models: VehicleModel[]): VehicleModelValidationError[] {
  const errors: VehicleModelValidationError[] = [];

  if (!Array.isArray(models) || models.length === 0) {
    errors.push({ type: "missing_flash_model", message: "车型目录为空" });
    errors.push({ type: "missing_standard_model", message: "车型目录为空" });
    return errors;
  }

  const hasFlash = models.some((m) => m.chargingClass === "flash_capable");
  const hasStandard = models.some((m) => m.chargingClass === "standard_dc");
  if (!hasFlash) errors.push({ type: "missing_flash_model", message: "车型目录缺少闪充车型" });
  if (!hasStandard) errors.push({ type: "missing_standard_model", message: "车型目录缺少普通车型" });

  const idSet = new Set<string>();
  const nameSet = new Set<string>();

  for (const model of models) {
    if (!model.id || typeof model.id !== "string" || model.id.trim() === "") {
      errors.push({ type: "duplicate_id", message: `车型 ID 为空`, modelId: model.id });
    } else if (idSet.has(model.id)) {
      errors.push({ type: "duplicate_id", message: `车型 ID 重复: ${model.id}`, modelId: model.id });
    } else {
      idSet.add(model.id);
    }

    const trimmedName = typeof model.name === "string" ? model.name.trim() : "";
    if (trimmedName === "") {
      errors.push({ type: "empty_name", message: `车型名称为空`, modelId: model.id });
    } else if (trimmedName.length > VEHICLE_MODEL_NAME_MAX_LENGTH) {
      errors.push({ type: "name_too_long", message: `车型名称超过 ${VEHICLE_MODEL_NAME_MAX_LENGTH} 字符: ${model.name}`, modelId: model.id });
    } else {
      const lowerName = trimmedName.toLowerCase();
      if (nameSet.has(lowerName)) {
        errors.push({ type: "duplicate_name", message: `车型名称重复: ${model.name}`, modelId: model.id });
      } else {
        nameSet.add(lowerName);
      }
    }

    if (typeof model.usableBatteryCapacityKWh !== "number" ||
        !Number.isFinite(model.usableBatteryCapacityKWh) ||
        model.usableBatteryCapacityKWh < CAPACITY_MIN_KWH ||
        model.usableBatteryCapacityKWh > CAPACITY_MAX_KWH) {
      errors.push({
        type: "invalid_capacity",
        message: `车型容量 ${model.usableBatteryCapacityKWh}kWh 不在 ${CAPACITY_MIN_KWH}–${CAPACITY_MAX_KWH} 范围内`,
        modelId: model.id,
      });
    }

    if (!isValidCurve(model.chargingCurve)) {
      errors.push({ type: "invalid_curve", message: `车型充电曲线不合法`, modelId: model.id });
    }
  }

  return errors;
}

export function migrateConfigV2ToV3(v2: SimulationConfig): { schemaVersion: 3; vehicleModels: VehicleModel[] } {
  const flashCurveSource = Array.isArray(v2.flashChargingCurve) && v2.flashChargingCurve.length >= 2
    ? v2.flashChargingCurve
    : flashCurve;
  const standardCurveSource = Array.isArray(v2.standardChargingCurve) && v2.standardChargingCurve.length >= 2
    ? v2.standardChargingCurve
    : standardCurve;

  return {
    schemaVersion: 3,
    vehicleModels: [
      {
        id: DEFAULT_FLASH_MODEL_ID,
        name: "兆瓦闪充车辆",
        chargingClass: "flash_capable",
        usableBatteryCapacityKWh: DEFAULT_FLASH_CAPACITY_KWH,
        chargingCurve: cloneChargingCurve(flashCurveSource),
      },
      {
        id: DEFAULT_STANDARD_MODEL_ID,
        name: "普通直流快充车辆",
        chargingClass: "standard_dc",
        usableBatteryCapacityKWh: DEFAULT_STANDARD_CAPACITY_KWH,
        chargingCurve: cloneChargingCurve(standardCurveSource),
      },
    ],
  };
}
