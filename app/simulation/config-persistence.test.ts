import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { baseConfig, flashCurve, scenarioPresets, standardCurve } from "./presets.js";
import type { SimulationConfigV3 } from "./types.js";
import { cloneConfigV3, getBaseConfigV3, getScenarioConfigV3, normalizeSimulationConfig, parseSimulationConfig } from "./config-persistence.js";
import { DEFAULT_FLASH_MODEL_ID, DEFAULT_STANDARD_MODEL_ID, cloneChargingCurve } from "./vehicle-models.js";

describe("parseSimulationConfig (strict)", () => {
  it("v2 输入迁移为 v3，保留自定义曲线", () => {
    const customFlash = flashCurve.map((p) => ({ ...p, powerKw: p.powerKw * 0.5 }));
    const customStandard = standardCurve.map((p) => ({ ...p, powerKw: p.powerKw + 100 }));
    const v2 = { ...baseConfig, flashChargingCurve: customFlash, standardChargingCurve: customStandard };
    const result = parseSimulationConfig(v2);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.config.schemaVersion, 3);
    const flashModel = result.config.vehicleModels.find((m) => m.chargingClass === "flash_capable")!;
    const standardModel = result.config.vehicleModels.find((m) => m.chargingClass === "standard_dc")!;
    assert.deepEqual(flashModel.chargingCurve, customFlash);
    assert.deepEqual(standardModel.chargingCurve, customStandard);
  });

  it("v3 合法输入返回深拷贝", () => {
    const v3 = getBaseConfigV3();
    const result = parseSimulationConfig(v3);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.notEqual(result.config.vehicleModels, v3.vehicleModels);
    assert.notEqual(result.config.vehicleModels[0].chargingCurve, v3.vehicleModels[0].chargingCurve);
  });

  it("非法 v3 Catalog 返回错误", () => {
    const badV3 = { ...getBaseConfigV3(), vehicleModels: [] };
    const result = parseSimulationConfig(badV3);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.error.includes("车型目录"));
  });

  it("不支持的 schemaVersion 返回错误", () => {
    const r1 = parseSimulationConfig({ schemaVersion: 1 });
    assert.equal(r1.ok, false);
    if (r1.ok) return;
    assert.ok(r1.error.includes("schemaVersion"));

    const r2 = parseSimulationConfig({ schemaVersion: 4 });
    assert.equal(r2.ok, false);

    const r3 = parseSimulationConfig(null);
    assert.equal(r3.ok, false);

    const r4 = parseSimulationConfig("not an object");
    assert.equal(r4.ok, false);
  });

  it("v3 缺少 vehicleModels 返回错误", () => {
    const result = parseSimulationConfig({ schemaVersion: 3 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.error.includes("vehicleModels"));
  });

  it("v3 非法 Catalog 不返回 baseConfigV3", () => {
    const result = parseSimulationConfig({ schemaVersion: 3, vehicleModels: [] });
    assert.equal(result.ok, false);
    if (result.ok) {
      assert.fail("should not return ok for empty vehicleModels");
    }
  });

  it("v2 自定义曲线不与 baseConfig 共享引用", () => {
    const v2 = { ...baseConfig, flashChargingCurve: flashCurve.map((p) => ({ ...p, powerKw: 999 })) };
    const result = parseSimulationConfig(v2);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const flashModel = result.config.vehicleModels.find((m) => m.chargingClass === "flash_capable")!;
    assert.equal(flashModel.chargingCurve[0].powerKw, 999);
    assert.equal(baseConfig.flashChargingCurve[0].powerKw, 400);
  });
});

describe("normalizeSimulationConfig (startup fallback)", () => {
  it("合法输入返回 v3", () => {
    const result = normalizeSimulationConfig(baseConfig);
    assert.equal(result.schemaVersion, 3);
    assert.equal(result.vehicleModels.length, 2);
  });

  it("非法输入回退到 baseConfigV3", () => {
    const result = normalizeSimulationConfig({ schemaVersion: 4 });
    assert.equal(result.schemaVersion, 3);
    assert.equal(result.vehicleModels.length, 2);
    assert.equal(result.gridMaxPowerKw, 1450);
  });

  it("null 回退到 baseConfigV3", () => {
    const result = normalizeSimulationConfig(null);
    assert.equal(result.schemaVersion, 3);
  });

  it("损坏 localStorage 模拟：非法 v3 Catalog 回退到默认", () => {
    const result = normalizeSimulationConfig({ schemaVersion: 3, vehicleModels: "not-an-array" });
    assert.equal(result.schemaVersion, 3);
    assert.equal(result.vehicleModels.length, 2);
  });
});

describe("cloneConfigV3", () => {
  it("深拷贝不共享 vehicleModels 引用", () => {
    const original = getBaseConfigV3();
    const cloned = cloneConfigV3(original);
    cloned.vehicleModels[0].name = "修改后";
    cloned.vehicleModels[0].chargingCurve[0].powerKw = 9999;
    assert.equal(original.vehicleModels[0].name, "兆瓦闪充车辆");
    assert.equal(original.vehicleModels[0].chargingCurve[0].powerKw, 400);
  });
});

describe("getBaseConfigV3", () => {
  it("返回 schemaVersion 3", () => {
    assert.equal(getBaseConfigV3().schemaVersion, 3);
  });

  it("包含默认车型", () => {
    const config = getBaseConfigV3();
    assert.equal(config.vehicleModels.length, 2);
    assert.ok(config.vehicleModels.some((m) => m.id === DEFAULT_FLASH_MODEL_ID));
    assert.ok(config.vehicleModels.some((m) => m.id === DEFAULT_STANDARD_MODEL_ID));
  });

  it("不包含旧曲线字段", () => {
    const config = getBaseConfigV3() as any;
    assert.equal(config.flashChargingCurve, undefined);
    assert.equal(config.standardChargingCurve, undefined);
  });

  it("保留所有标量配置", () => {
    const config = getBaseConfigV3();
    assert.equal(config.gridMaxPowerKw, 1450);
    assert.equal(config.flashShare, 0.35);
    assert.equal(config.randomSeed, 20260723);
    assert.equal(config.storageMaxChargePowerKw, 600);
  });
});

describe("getScenarioConfigV3", () => {
  it("preset 返回 v3", () => {
    const result = getScenarioConfigV3("电网限容", scenarioPresets["电网限容"]);
    assert.equal(result.schemaVersion, 3);
    assert.equal(result.scenarioName, "电网限容");
    assert.equal(result.gridMaxPowerKw, 800);
    assert.equal(result.storageInitialSocPercent, 32);
  });

  it("preset 保留 vehicleModels", () => {
    const result = getScenarioConfigV3("闪充车占比高", scenarioPresets["闪充车占比高"]);
    assert.equal(result.vehicleModels.length, 2);
    assert.equal(result.flashShare, 0.78);
  });

  it("preset vehicleModels 不与 base 共享引用", () => {
    const result = getScenarioConfigV3("标准双枪闪充桩", scenarioPresets["标准双枪闪充桩"]);
    const base = getBaseConfigV3();
    assert.notEqual(result.vehicleModels, base.vehicleModels);
    assert.notEqual(result.vehicleModels[0].chargingCurve, base.vehicleModels[0].chargingCurve);
  });
});

describe("JSON export 格式", () => {
  it("v3 config 序列化不含旧曲线字段", () => {
    const config = getBaseConfigV3();
    const json = JSON.stringify(config);
    const parsed = JSON.parse(json);
    assert.equal(parsed.schemaVersion, 3);
    assert.ok(Array.isArray(parsed.vehicleModels));
    assert.equal(parsed.flashChargingCurve, undefined);
    assert.equal(parsed.standardChargingCurve, undefined);
  });

  it("v3 round-trip 保留完整车型目录", () => {
    const config = cloneConfigV3(getBaseConfigV3());
    config.vehicleModels.push({
      id: "test-model",
      name: "测试车型",
      chargingClass: "flash_capable",
      usableBatteryCapacityKWh: 500,
      chargingCurve: cloneChargingCurve(flashCurve),
    });
    const json = JSON.stringify(config);
    const result = parseSimulationConfig(JSON.parse(json));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.config.vehicleModels.length, 3);
    const testModel = result.config.vehicleModels.find((m) => m.id === "test-model")!;
    assert.equal(testModel.name, "测试车型");
    assert.equal(testModel.usableBatteryCapacityKWh, 500);
  });
});

describe("Reset 保留 Catalog", () => {
  it("v3 config 模拟 Reset 保留 vehicleModels", () => {
    const config = getBaseConfigV3();
    config.vehicleModels[0].name = "自定义名称";
    const { vehicleModels, ...rest } = config;
    const resetConfig = { ...rest, vehicleModels: cloneConfigV3(config).vehicleModels } as SimulationConfigV3;
    assert.equal(resetConfig.vehicleModels[0].name, "自定义名称");
    assert.notEqual(resetConfig.vehicleModels, config.vehicleModels);
  });
});

describe("import 不覆盖当前配置（模拟）", () => {
  it("非法 import parse 返回 false，调用方可保持当前 config 不变", () => {
    const currentConfig = cloneConfigV3(getBaseConfigV3());
    const baseModelCount = currentConfig.vehicleModels.length;
    currentConfig.vehicleModels.push({
      id: "custom-model",
      name: "自定义车型",
      chargingClass: "flash_capable",
      usableBatteryCapacityKWh: 300,
      chargingCurve: cloneChargingCurve(flashCurve),
    });
    currentConfig.gridMaxPowerKw = 9999;

    const badImport = parseSimulationConfig({ schemaVersion: 4 });
    assert.equal(badImport.ok, false);

    const badCatalog = parseSimulationConfig({ schemaVersion: 3, vehicleModels: [] });
    assert.equal(badCatalog.ok, false);

    const badSyntax = parseSimulationConfig({ schemaVersion: 3, vehicleModels: [{ id: "", name: "", chargingClass: "flash_capable", usableBatteryCapacityKWh: -1, chargingCurve: [] }] });
    assert.equal(badSyntax.ok, false);

    assert.equal(currentConfig.vehicleModels.length, baseModelCount + 1);
    assert.equal(currentConfig.gridMaxPowerKw, 9999);
  });
});
