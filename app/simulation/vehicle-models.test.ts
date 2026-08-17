import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { baseConfig, flashCurve, standardCurve } from "./presets.js";
import type { SimulationConfig } from "./types.js";
import {
  cloneChargingCurve,
  cloneDefaultChargingCurve,
  cloneVehicleModel,
  cloneVehicleModels,
  DEFAULT_FLASH_CAPACITY_KWH,
  DEFAULT_FLASH_MODEL_ID,
  DEFAULT_STANDARD_CAPACITY_KWH,
  DEFAULT_STANDARD_MODEL_ID,
  defaultVehicleModels,
  migrateConfigV2ToV3,
  validateVehicleModels,
} from "./vehicle-models.js";

describe("默认车型目录", () => {
  it("包含一个 flash_capable 和一个 standard_dc", () => {
    const flash = defaultVehicleModels.filter((m) => m.chargingClass === "flash_capable");
    const standard = defaultVehicleModels.filter((m) => m.chargingClass === "standard_dc");
    assert.equal(flash.length, 1);
    assert.equal(standard.length, 1);
    assert.equal(defaultVehicleModels.length, 2);
  });

  it("默认容量为 112/76 kWh", () => {
    const flash = defaultVehicleModels.find((m) => m.chargingClass === "flash_capable")!;
    const standard = defaultVehicleModels.find((m) => m.chargingClass === "standard_dc")!;
    assert.equal(flash.usableBatteryCapacityKWh, DEFAULT_FLASH_CAPACITY_KWH);
    assert.equal(flash.usableBatteryCapacityKWh, 112);
    assert.equal(standard.usableBatteryCapacityKWh, DEFAULT_STANDARD_CAPACITY_KWH);
    assert.equal(standard.usableBatteryCapacityKWh, 76);
  });

  it("默认车型曲线来自正确类别模板", () => {
    const flash = defaultVehicleModels.find((m) => m.chargingClass === "flash_capable")!;
    const standard = defaultVehicleModels.find((m) => m.chargingClass === "standard_dc")!;
    assert.deepEqual(flash.chargingCurve, flashCurve);
    assert.deepEqual(standard.chargingCurve, standardCurve);
  });

  it("两个车型曲线互不共享引用", () => {
    const models = cloneVehicleModels(defaultVehicleModels);
    const flash = models.find((m) => m.chargingClass === "flash_capable")!;
    const standard = models.find((m) => m.chargingClass === "standard_dc")!;
    assert.notEqual(flash.chargingCurve, standard.chargingCurve);
    assert.notEqual(flash.chargingCurve[0], standard.chargingCurve[0]);
    flash.chargingCurve[0].powerKw = 9999;
    assert.equal(standard.chargingCurve[0].powerKw, 260);
    assert.equal(defaultVehicleModels[0].chargingCurve[0].powerKw, 400);
    assert.equal(defaultVehicleModels[1].chargingCurve[0].powerKw, 260);
  });

  it("固定默认 ID 为 default-flash 和 default-standard", () => {
    const flash = defaultVehicleModels.find((m) => m.chargingClass === "flash_capable")!;
    const standard = defaultVehicleModels.find((m) => m.chargingClass === "standard_dc")!;
    assert.equal(flash.id, DEFAULT_FLASH_MODEL_ID);
    assert.equal(flash.id, "default-flash");
    assert.equal(standard.id, DEFAULT_STANDARD_MODEL_ID);
    assert.equal(standard.id, "default-standard");
  });
});

describe("clone helper", () => {
  it("cloneVehicleModels 后原对象完全不受修改影响", () => {
    const original = cloneVehicleModels(defaultVehicleModels);
    const cloned = cloneVehicleModels(original);
    cloned[0].name = "修改后的名称";
    cloned[0].chargingCurve[0].powerKw = 8888;
    cloned[0].usableBatteryCapacityKWh = 999;
    cloned[1].id = "changed-id";
    assert.equal(original[0].name, "兆瓦闪充车辆");
    assert.equal(original[0].chargingCurve[0].powerKw, 400);
    assert.equal(original[0].usableBatteryCapacityKWh, 112);
    assert.equal(original[1].id, DEFAULT_STANDARD_MODEL_ID);
    assert.equal(defaultVehicleModels[0].name, "兆瓦闪充车辆");
    assert.equal(defaultVehicleModels[0].chargingCurve[0].powerKw, 400);
  });

  it("cloneDefaultChargingCurve 返回独立数组", () => {
    const a = cloneDefaultChargingCurve("flash_capable");
    const b = cloneDefaultChargingCurve("flash_capable");
    assert.deepEqual(a, flashCurve);
    assert.notEqual(a, b);
    assert.notEqual(a[0], b[0]);
    a[0].powerKw = 12345;
    assert.equal(b[0].powerKw, 400);
  });

  it("cloneVehicleModel 深拷贝曲线", () => {
    const model = defaultVehicleModels[0];
    const cloned = cloneVehicleModel(model);
    assert.deepEqual(cloned, model);
    assert.notEqual(cloned, model);
    assert.notEqual(cloned.chargingCurve, model.chargingCurve);
    assert.notEqual(cloned.chargingCurve[0], model.chargingCurve[0]);
  });
});

describe("v2 → v3 迁移", () => {
  it("迁移保留自定义 flashChargingCurve", () => {
    const customFlash = flashCurve.map((p) => ({ ...p, powerKw: p.powerKw * 0.8 }));
    const v2 = { ...baseConfig, flashChargingCurve: customFlash };
    const v3 = migrateConfigV2ToV3(v2);
    const flashModel = v3.vehicleModels.find((m) => m.chargingClass === "flash_capable")!;
    assert.deepEqual(flashModel.chargingCurve, customFlash);
  });

  it("迁移保留自定义 standardChargingCurve", () => {
    const customStandard = standardCurve.map((p) => ({ ...p, powerKw: p.powerKw + 50 }));
    const v2 = { ...baseConfig, standardChargingCurve: customStandard };
    const v3 = migrateConfigV2ToV3(v2);
    const standardModel = v3.vehicleModels.find((m) => m.chargingClass === "standard_dc")!;
    assert.deepEqual(standardModel.chargingCurve, customStandard);
  });

  it("迁移对象与原 v2 曲线不共享引用", () => {
    const v2 = { ...baseConfig };
    const v3 = migrateConfigV2ToV3(v2);
    const flashModel = v3.vehicleModels.find((m) => m.chargingClass === "flash_capable")!;
    const standardModel = v3.vehicleModels.find((m) => m.chargingClass === "standard_dc")!;
    assert.notEqual(flashModel.chargingCurve, v2.flashChargingCurve);
    assert.notEqual(standardModel.chargingCurve, v2.standardChargingCurve);
    assert.notEqual(flashModel.chargingCurve[0], v2.flashChargingCurve[0]);
    assert.notEqual(standardModel.chargingCurve[0], v2.standardChargingCurve[0]);
    flashModel.chargingCurve[0].powerKw = 9999;
    assert.equal(v2.flashChargingCurve[0].powerKw, 400);
  });

  it("迁移 schemaVersion = 3", () => {
    const v3 = migrateConfigV2ToV3(baseConfig);
    assert.equal(v3.schemaVersion, 3);
  });

  it("迁移使用固定默认 ID", () => {
    const v3 = migrateConfigV2ToV3(baseConfig);
    const flash = v3.vehicleModels.find((m) => m.chargingClass === "flash_capable")!;
    const standard = v3.vehicleModels.find((m) => m.chargingClass === "standard_dc")!;
    assert.equal(flash.id, "default-flash");
    assert.equal(standard.id, "default-standard");
  });
});

describe("车型目录校验", () => {
  it("拒绝没有 flash model", () => {
    const models = [{ ...defaultVehicleModels[1] }];
    const errors = validateVehicleModels(models);
    assert.ok(errors.some((e) => e.type === "missing_flash_model"));
  });

  it("拒绝没有 standard model", () => {
    const models = [{ ...defaultVehicleModels[0] }];
    const errors = validateVehicleModels(models);
    assert.ok(errors.some((e) => e.type === "missing_standard_model"));
  });

  it("拒绝重复 ID", () => {
    const models = [
      { ...defaultVehicleModels[0] },
      { ...defaultVehicleModels[1], id: defaultVehicleModels[0].id },
    ];
    const errors = validateVehicleModels(models);
    assert.ok(errors.some((e) => e.type === "duplicate_id"));
  });

  it("拒绝空名称、trim 后空名称、重名", () => {
    const empty = validateVehicleModels([
      { ...defaultVehicleModels[0], name: "" },
      { ...defaultVehicleModels[1] },
    ]);
    assert.ok(empty.some((e) => e.type === "empty_name"));

    const whitespace = validateVehicleModels([
      { ...defaultVehicleModels[0], name: "   " },
      { ...defaultVehicleModels[1] },
    ]);
    assert.ok(whitespace.some((e) => e.type === "empty_name"));

    const duplicate = validateVehicleModels([
      { ...defaultVehicleModels[0], id: "a" },
      { ...defaultVehicleModels[1], id: "b", name: defaultVehicleModels[0].name },
    ]);
    assert.ok(duplicate.some((e) => e.type === "duplicate_name"));
  });

  it("拒绝容量越界，边界值 20/2000 有效", () => {
    const tooLow = validateVehicleModels([
      { ...defaultVehicleModels[0], usableBatteryCapacityKWh: 19 },
      { ...defaultVehicleModels[1] },
    ]);
    assert.ok(tooLow.some((e) => e.type === "invalid_capacity"));

    const tooHigh = validateVehicleModels([
      { ...defaultVehicleModels[0], usableBatteryCapacityKWh: 2001 },
      { ...defaultVehicleModels[1] },
    ]);
    assert.ok(tooHigh.some((e) => e.type === "invalid_capacity"));

    const nanVal = validateVehicleModels([
      { ...defaultVehicleModels[0], usableBatteryCapacityKWh: NaN },
      { ...defaultVehicleModels[1] },
    ]);
    assert.ok(nanVal.some((e) => e.type === "invalid_capacity"));

    const infVal = validateVehicleModels([
      { ...defaultVehicleModels[0], usableBatteryCapacityKWh: Infinity },
      { ...defaultVehicleModels[1] },
    ]);
    assert.ok(infVal.some((e) => e.type === "invalid_capacity"));

    const boundaryLow = validateVehicleModels([
      { ...defaultVehicleModels[0], usableBatteryCapacityKWh: 20 },
      { ...defaultVehicleModels[1] },
    ]);
    assert.ok(!boundaryLow.some((e) => e.type === "invalid_capacity"));

    const boundaryHigh = validateVehicleModels([
      { ...defaultVehicleModels[0], usableBatteryCapacityKWh: 2000 },
      { ...defaultVehicleModels[1] },
    ]);
    assert.ok(!boundaryHigh.some((e) => e.type === "invalid_capacity"));
  });

  it("拒绝明显非法 chargingCurve", () => {
    const tooFew = validateVehicleModels([
      { ...defaultVehicleModels[0], chargingCurve: [{ soc: 0, powerKw: 100 }] },
      { ...defaultVehicleModels[1] },
    ]);
    assert.ok(tooFew.some((e) => e.type === "invalid_curve"));

    const negativeSoc = validateVehicleModels([
      { ...defaultVehicleModels[0], chargingCurve: [{ soc: -1, powerKw: 100 }, { soc: 50, powerKw: 200 }] },
      { ...defaultVehicleModels[1] },
    ]);
    assert.ok(negativeSoc.some((e) => e.type === "invalid_curve"));

    const unsorted = validateVehicleModels([
      { ...defaultVehicleModels[0], chargingCurve: [{ soc: 50, powerKw: 100 }, { soc: 20, powerKw: 200 }] },
      { ...defaultVehicleModels[1] },
    ]);
    assert.ok(unsorted.some((e) => e.type === "invalid_curve"));

    const negativePower = validateVehicleModels([
      { ...defaultVehicleModels[0], chargingCurve: [{ soc: 0, powerKw: -1 }, { soc: 50, powerKw: 200 }] },
      { ...defaultVehicleModels[1] },
    ]);
    assert.ok(negativePower.some((e) => e.type === "invalid_curve"));
  });

  it("合法目录返回空错误数组", () => {
    const errors = validateVehicleModels(cloneVehicleModels(defaultVehicleModels));
    assert.equal(errors.length, 0);
  });
});
