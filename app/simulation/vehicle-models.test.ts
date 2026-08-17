import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { baseConfig, flashCurve, standardCurve } from "./presets.js";
import type { SimulationConfig, VehicleModel } from "./types.js";
import {
  canChangeModelClass,
  canDeleteVehicleModel,
  changeModelClass,
  cloneChargingCurve,
  cloneDefaultChargingCurve,
  cloneVehicleModel,
  cloneVehicleModels,
  createVehicleModel,
  DEFAULT_FLASH_CAPACITY_KWH,
  DEFAULT_FLASH_MODEL_ID,
  DEFAULT_STANDARD_CAPACITY_KWH,
  DEFAULT_STANDARD_MODEL_ID,
  defaultVehicleModels,
  deleteVehicleModel,
  isDefaultVehicleModel,
  migrateConfigV2ToV3,
  renameVehicleModel,
  resolveVehicleModelId,
  restoreDefaultCurve,
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

describe("createVehicleModel", () => {
  it("新建 flash 车型：默认容量112，curve 为 flash 模板克隆", () => {
    const result = createVehicleModel("测试闪充", "flash_capable", 112);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.model.chargingClass, "flash_capable");
    assert.equal(result.model.usableBatteryCapacityKWh, 112);
    assert.deepEqual(result.model.chargingCurve, flashCurve);
    assert.equal(result.model.name, "测试闪充");
    assert.ok(result.model.id.startsWith("vm-"));
  });

  it("新建 standard 车型：默认容量76，curve 为 standard 模板克隆", () => {
    const result = createVehicleModel("测试普通", "standard_dc", 76);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.model.usableBatteryCapacityKWh, 76);
    assert.deepEqual(result.model.chargingCurve, standardCurve);
  });

  it("两个新车型 curve 不共享引用", () => {
    const r1 = createVehicleModel("A", "flash_capable", 100);
    const r2 = createVehicleModel("B", "flash_capable", 200);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    if (!r1.ok || !r2.ok) return;
    assert.notEqual(r1.model.chargingCurve, r2.model.chargingCurve);
    assert.notEqual(r1.model.chargingCurve[0], r2.model.chargingCurve[0]);
    r1.model.chargingCurve[0].powerKw = 9999;
    assert.equal(r2.model.chargingCurve[0].powerKw, flashCurve[0].powerKw);
  });

  it("名称为空拒绝", () => {
    const r1 = createVehicleModel("", "flash_capable", 100);
    assert.equal(r1.ok, false);
    const r2 = createVehicleModel("   ", "flash_capable", 100);
    assert.equal(r2.ok, false);
  });

  it("容量越界拒绝", () => {
    assert.equal(createVehicleModel("X", "flash_capable", 19).ok, false);
    assert.equal(createVehicleModel("X", "flash_capable", 2001).ok, false);
    assert.equal(createVehicleModel("X", "flash_capable", NaN).ok, false);
    assert.equal(createVehicleModel("X", "flash_capable", Infinity).ok, false);
    assert.equal(createVehicleModel("X", "flash_capable", 20).ok, true);
    assert.equal(createVehicleModel("X", "flash_capable", 2000).ok, true);
  });
});

describe("renameVehicleModel", () => {
  it("重命名改变 name 但不改变 id", () => {
    const models = cloneVehicleModels(defaultVehicleModels);
    const result = renameVehicleModel(models, DEFAULT_FLASH_MODEL_ID, "新名称");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const renamed = result.models.find((m) => m.id === DEFAULT_FLASH_MODEL_ID)!;
    assert.equal(renamed.name, "新名称");
    assert.equal(renamed.id, DEFAULT_FLASH_MODEL_ID);
  });

  it("空名称拒绝", () => {
    const models = cloneVehicleModels(defaultVehicleModels);
    assert.equal(renameVehicleModel(models, DEFAULT_FLASH_MODEL_ID, "").ok, false);
    assert.equal(renameVehicleModel(models, DEFAULT_FLASH_MODEL_ID, "   ").ok, false);
  });

  it("重名拒绝", () => {
    const models = cloneVehicleModels(defaultVehicleModels);
    assert.equal(renameVehicleModel(models, DEFAULT_FLASH_MODEL_ID, "普通直流快充车辆").ok, false);
  });

  it("大小写不敏感重名拒绝", () => {
    const models = cloneVehicleModels(defaultVehicleModels);
    assert.equal(renameVehicleModel(models, DEFAULT_FLASH_MODEL_ID, "普通直流快充车辆".toUpperCase()).ok, false);
  });

  it("改回自己的名字允许", () => {
    const models = cloneVehicleModels(defaultVehicleModels);
    const result = renameVehicleModel(models, DEFAULT_FLASH_MODEL_ID, "兆瓦闪充车辆");
    assert.equal(result.ok, true);
  });
});

describe("canChangeModelClass / changeModelClass", () => {
  it("standard 切 flash：curve 保持、capacity 保持、id 保持", () => {
    const models = cloneVehicleModels(defaultVehicleModels);
    const extra = createVehicleModel("额外普通", "standard_dc", 100);
    assert.equal(extra.ok, true);
    if (!extra.ok) return;
    models.push(extra.model);
    assert.equal(canChangeModelClass(models, DEFAULT_STANDARD_MODEL_ID, "flash_capable"), true);
    const changed = changeModelClass(models.find((m) => m.id === DEFAULT_STANDARD_MODEL_ID)!, "flash_capable");
    assert.equal(changed.chargingClass, "flash_capable");
    assert.equal(changed.usableBatteryCapacityKWh, DEFAULT_STANDARD_CAPACITY_KWH);
    assert.equal(changed.id, DEFAULT_STANDARD_MODEL_ID);
    assert.deepEqual(changed.chargingCurve, standardCurve);
  });

  it("最后一个 flash 不允许切走", () => {
    const models = cloneVehicleModels(defaultVehicleModels);
    assert.equal(canChangeModelClass(models, DEFAULT_FLASH_MODEL_ID, "standard_dc"), false);
  });

  it("最后一个 standard 不允许切走", () => {
    const models = cloneVehicleModels(defaultVehicleModels);
    assert.equal(canChangeModelClass(models, DEFAULT_STANDARD_MODEL_ID, "flash_capable"), false);
  });

  it("有多个 flash 时允许切走一个", () => {
    const models = cloneVehicleModels(defaultVehicleModels);
    const extra = createVehicleModel("额外闪充", "flash_capable", 200);
    assert.equal(extra.ok, true);
    if (!extra.ok) return;
    models.push(extra.model);
    assert.equal(canChangeModelClass(models, DEFAULT_FLASH_MODEL_ID, "standard_dc"), true);
  });

  it("已是目标类别时返回 false", () => {
    const models = cloneVehicleModels(defaultVehicleModels);
    assert.equal(canChangeModelClass(models, DEFAULT_FLASH_MODEL_ID, "flash_capable"), false);
  });
});

describe("restoreDefaultCurve", () => {
  it("standard 恢复 → standardCurve", () => {
    const model = { ...defaultVehicleModels[1], chargingCurve: [{ soc: 0, powerKw: 999 }, { soc: 100, powerKw: 0 }] };
    const restored = restoreDefaultCurve(model);
    assert.deepEqual(restored.chargingCurve, standardCurve);
    assert.equal(restored.id, model.id);
    assert.equal(restored.name, model.name);
  });

  it("切到 flash 后恢复 → flashCurve", () => {
    const model = { ...defaultVehicleModels[1], chargingClass: "flash_capable" as const };
    const restored = restoreDefaultCurve(model);
    assert.deepEqual(restored.chargingCurve, flashCurve);
  });
});

describe("resolveVehicleModelId", () => {
  it("preferredId 存在时直接使用", () => {
    const models = cloneVehicleModels(defaultVehicleModels);
    assert.equal(resolveVehicleModelId(models, DEFAULT_STANDARD_MODEL_ID), DEFAULT_STANDARD_MODEL_ID);
  });

  it("preferredId 不存在，default-flash 存在时使用 default-flash", () => {
    const models = cloneVehicleModels(defaultVehicleModels);
    assert.equal(resolveVehicleModelId(models, "nonexistent"), DEFAULT_FLASH_MODEL_ID);
  });

  it("preferredId 不存在，default-flash 也不存在时使用第一个模型", () => {
    const models: VehicleModel[] = [
      { id: "flash-a", name: "闪充A", chargingClass: "flash_capable", usableBatteryCapacityKWh: 100, chargingCurve: cloneChargingCurve(flashCurve) },
      { id: "std-a", name: "普通A", chargingClass: "standard_dc", usableBatteryCapacityKWh: 80, chargingCurve: cloneChargingCurve(standardCurve) },
    ];
    assert.equal(resolveVehicleModelId(models, "nonexistent"), "flash-a");
  });

  it("preferredId 为空字符串时回退到 default-flash 或第一个", () => {
    const models = cloneVehicleModels(defaultVehicleModels);
    assert.equal(resolveVehicleModelId(models, ""), DEFAULT_FLASH_MODEL_ID);
    const custom: VehicleModel[] = [
      { id: "x", name: "X", chargingClass: "flash_capable", usableBatteryCapacityKWh: 100, chargingCurve: cloneChargingCurve(flashCurve) },
    ];
    assert.equal(resolveVehicleModelId(custom, ""), "x");
  });

  it("无 preferredId 时回退到 default-flash", () => {
    const models = cloneVehicleModels(defaultVehicleModels);
    assert.equal(resolveVehicleModelId(models), DEFAULT_FLASH_MODEL_ID);
  });

  it("空数组返回空字符串不 crash", () => {
    assert.equal(resolveVehicleModelId([]), "");
    assert.equal(resolveVehicleModelId([], "anything"), "");
  });
});

describe("deleteVehicleModel", () => {
  it("default-flash 不能删除", () => {
    const models = cloneVehicleModels(defaultVehicleModels);
    const result = deleteVehicleModel(models, DEFAULT_FLASH_MODEL_ID);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.error.includes("默认"));
  });

  it("default-standard 不能删除", () => {
    const models = cloneVehicleModels(defaultVehicleModels);
    const result = deleteVehicleModel(models, DEFAULT_STANDARD_MODEL_ID);
    assert.equal(result.ok, false);
  });

  it("普通 custom model 可以删除", () => {
    const models = cloneVehicleModels(defaultVehicleModels);
    const custom = createVehicleModel("自定义闪充", "flash_capable", 300);
    assert.equal(custom.ok, true);
    if (!custom.ok) return;
    models.push(custom.model);
    const result = deleteVehicleModel(models, custom.model.id);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.models.length, 2);
    assert.ok(!result.models.some((m) => m.id === custom.model.id));
  });

  it("删除不 mutate 原 Catalog", () => {
    const models = cloneVehicleModels(defaultVehicleModels);
    const custom = createVehicleModel("X", "flash_capable", 100);
    assert.equal(custom.ok, true);
    if (!custom.ok) return;
    models.push(custom.model);
    const originalLength = models.length;
    const result = deleteVehicleModel(models, custom.model.id);
    assert.equal(result.ok, true);
    assert.equal(models.length, originalLength);
  });

  it("default + custom 同类，删除 custom 成功", () => {
    const models = cloneVehicleModels(defaultVehicleModels);
    const custom = createVehicleModel("自定义标准", "standard_dc", 200);
    assert.equal(custom.ok, true);
    if (!custom.ok) return;
    models.push(custom.model);
    const result = deleteVehicleModel(models, custom.model.id);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.models.some((m) => m.id === DEFAULT_STANDARD_MODEL_ID));
  });

  it("类别最后车型不能删除（default 被切走后 custom 成为唯一）", () => {
    const models = cloneVehicleModels(defaultVehicleModels);
    const flashDefault = models.find((m) => m.id === DEFAULT_FLASH_MODEL_ID)!;
    flashDefault.chargingClass = "standard_dc";
    const customFlash = createVehicleModel("唯一闪充", "flash_capable", 200);
    assert.equal(customFlash.ok, true);
    if (!customFlash.ok) return;
    models.push(customFlash.model);
    const result = deleteVehicleModel(models, customFlash.model.id);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.error.includes("闪充"));
  });

  it("多个 custom flash 删除一个成功", () => {
    const models = cloneVehicleModels(defaultVehicleModels);
    const a = createVehicleModel("A", "flash_capable", 100);
    const b = createVehicleModel("B", "flash_capable", 200);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    if (!a.ok || !b.ok) return;
    models.push(a.model, b.model);
    const originalLength = models.length;
    const result = deleteVehicleModel(models, a.model.id);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.models.length, originalLength - 1);
  });

  it("不存在的 modelId 安全失败", () => {
    const models = cloneVehicleModels(defaultVehicleModels);
    const result = deleteVehicleModel(models, "nonexistent");
    assert.equal(result.ok, false);
    assert.equal(models.length, 2);
  });
});
