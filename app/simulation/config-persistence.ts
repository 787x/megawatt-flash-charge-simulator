import { baseConfig, scenarioPresets } from "./presets.js";
import type { SimulationConfig, SimulationConfigV3 } from "./types.js";
import {
  cloneVehicleModels,
  migrateConfigV2ToV3,
  validateVehicleModels,
  type VehicleModelValidationError,
} from "./vehicle-models.js";

let _baseConfigV3: SimulationConfigV3 | null = null;

export function getBaseConfigV3(): SimulationConfigV3 {
  if (!_baseConfigV3) {
    const v3Partial = migrateConfigV2ToV3(baseConfig);
    const { flashChargingCurve: _fc, standardChargingCurve: _sc, schemaVersion: _sv, ...rest } = baseConfig;
    _baseConfigV3 = { ...rest, schemaVersion: 3, vehicleModels: v3Partial.vehicleModels } as SimulationConfigV3;
  }
  return _baseConfigV3;
}

export type ParseConfigResult =
  | { ok: true; config: SimulationConfigV3 }
  | { ok: false; error: string };

export function parseSimulationConfig(input: unknown): ParseConfigResult {
  if (input == null || typeof input !== "object") {
    return { ok: false, error: "输入不是合法 JSON 对象" };
  }

  const obj = input as Record<string, unknown>;

  if (obj.schemaVersion === 3) {
    const v3 = obj as unknown as SimulationConfigV3;
    if (!Array.isArray(v3.vehicleModels)) {
      return { ok: false, error: "v3 配置缺少 vehicleModels 数组" };
    }
    const errors: VehicleModelValidationError[] = validateVehicleModels(v3.vehicleModels);
    if (errors.length > 0) {
      return { ok: false, error: `车型目录不合法：${errors.map((e) => e.message).join("；")}` };
    }
    const { vehicleModels: _ignored, ...rest } = v3;
    return {
      ok: true,
      config: {
        ...rest,
        schemaVersion: 3,
        vehicleModels: cloneVehicleModels(v3.vehicleModels),
      } as SimulationConfigV3,
    };
  }

  if (obj.schemaVersion === 2 || obj.schemaVersion === undefined) {
    const merged = { ...baseConfig, ...obj } as SimulationConfig;
    merged.schemaVersion = 2;
    const v3Partial = migrateConfigV2ToV3(merged);
    const errors = validateVehicleModels(v3Partial.vehicleModels);
    if (errors.length > 0) {
      return { ok: false, error: `v2 迁移后车型目录不合法：${errors.map((e) => e.message).join("；")}` };
    }
    const { flashChargingCurve: _fc, standardChargingCurve: _sc, schemaVersion: _sv, ...rest } = merged;
    return {
      ok: true,
      config: {
        ...rest,
        schemaVersion: 3,
        vehicleModels: v3Partial.vehicleModels,
      } as SimulationConfigV3,
    };
  }

  return { ok: false, error: `不支持的 schemaVersion: ${String(obj.schemaVersion)}` };
}

export function normalizeSimulationConfig(input: unknown): SimulationConfigV3 {
  const result = parseSimulationConfig(input);
  if (result.ok) return result.config;
  return cloneConfigV3(getBaseConfigV3());
}

export function cloneConfigV3(config: SimulationConfigV3): SimulationConfigV3 {
  const { vehicleModels, ...rest } = config;
  return {
    ...rest,
    vehicleModels: cloneVehicleModels(vehicleModels),
  } as SimulationConfigV3;
}

export function getScenarioConfigV3(name: string, partial: Partial<SimulationConfig>): SimulationConfigV3 {
  const base = cloneConfigV3(getBaseConfigV3());
  const { flashChargingCurve: _fc, standardChargingCurve: _sc, schemaVersion: _sv, vehicleModels: _vm, ...scalarOverrides } = partial as any;
  return { ...base, ...scalarOverrides, scenarioName: name } as SimulationConfigV3;
}
