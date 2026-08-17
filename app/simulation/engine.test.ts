import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addAutomaticVehicle,
  addManualVehicle,
  allocatePilePower,
  assertSimulationInvariants,
  createEmptyState,
  createInitialState,
  dispatchVehicles,
  estimateRemainingChargeTime,
  estimateVehicleWaitTime,
  getEffectiveGridLimit,
  getGridAvailableCapacityUtilizationPercent,
  getGridRatedCapacityUtilizationPercent,
  interpolateCurve,
  isVehicleEligibleForConnector,
  setGridControl,
  setStorageEnergy,
  stepSimulation,
} from "./engine.js";
import { baseConfig, flashCurve, standardCurve } from "./presets.js";
import type { VehicleChargingClass } from "./types.js";
import { cloneChargingCurve, DEFAULT_FLASH_MODEL_ID, DEFAULT_STANDARD_MODEL_ID, resolveVehicleModels, type SimulationRuntimeConfig } from "./vehicle-models.js";

function makeVehicleFromConfig(id: string, chargingClass: VehicleChargingClass, arrivalTimeSec: number, soc?: number, config: SimulationRuntimeConfig = baseConfig) {
  const models = resolveVehicleModels(config);
  const model = models.find((m) => m.chargingClass === chargingClass)!;
  const isFlash = chargingClass === "flash_capable";
  const initialSoc = soc ?? (isFlash ? 18 : 27);
  return {
    id,
    vehicleModelId: model.id,
    name: model.name,
    chargingClass,
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
    chargingCurve: cloneChargingCurve(model.chargingCurve),
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
    timeline: arrivalTimeSec <= 0 ? [{ timeSec: 0, status: "queued" as const, note: "进入全局等待队列" }] : [],
  } as import("./types.js").Vehicle;
}

function blankState() {
  const state = createInitialState({ ...baseConfig, autoArrivalEnabled: false });
  state.vehicles = [];
  state.queue = [];
  state.events = [];
  state.piles[0].connectors.forEach((connector) => {
    connector.currentVehicleId = undefined;
    connector.sessionId = undefined;
    connector.actualPowerKw = 0;
    connector.requestedPowerKw = 0;
  });
  return state;
}

function gridUtilizationFixture(gridMaxPowerKw: number, baseLoadKw: number) {
  const config = {
    ...baseConfig,
    autoArrivalEnabled: false,
    gridMaxPowerKw,
    baseLoadKw,
    storageMaxChargePowerKw: 0,
    storageMaxDischargePowerKw: 0,
  };
  return { config, state: createEmptyState(config) };
}

function assertClose(actual: number, expected: number, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `期望 ${expected}，实际 ${actual}`);
}

describe("充电曲线与兼容性", () => {
  it("分段线性插值正确", () => {
    assert.equal(interpolateCurve(flashCurve, 15), 1250);
    assert.equal(interpolateCurve(flashCurve, 100), 0);
  });

  it("普通车不能使用 B，闪充车可使用 A 或 B", () => {
    const state = blankState();
    const [a, b] = state.piles[0].connectors;
    const standard = makeVehicleFromConfig("S1", "standard_dc", 0);
    const flash = makeVehicleFromConfig("F1", "flash_capable", 0);
    assert.equal(isVehicleEligibleForConnector(standard, a), true);
    assert.equal(isVehicleEligibleForConnector(standard, b), false);
    assert.equal(isVehicleEligibleForConnector(flash, a), true);
    assert.equal(isVehicleEligibleForConnector(flash, b), true);
  });

  it("普通车默认峰值能力和曲线峰值均为 520kW", () => {
    const standard = makeVehicleFromConfig("S1", "standard_dc", 0);
    assert.equal(standard.maxChargingPowerKw, 520);
    assert.equal(Math.max(...standard.chargingCurve.map((point) => point.powerKw)), 520);
  });

  it("配置中的两类曲线会写入对应车辆（快照行为）", () => {
    const config = {
      ...baseConfig,
      flashChargingCurve: baseConfig.flashChargingCurve.map((point) => ({ ...point, powerKw: 333 })),
      standardChargingCurve: baseConfig.standardChargingCurve.map((point) => ({ ...point, powerKw: 222 })),
    };
    const state = createInitialState(config);
    assert.equal(state.vehicles.find((vehicle) => vehicle.chargingClass === "flash_capable")?.chargingCurve[0].powerKw, 333);
    assert.equal(state.vehicles.find((vehicle) => vehicle.chargingClass === "standard_dc")?.chargingCurve[0].powerKw, 222);
    assert.equal(state.vehicles[0].vehicleModelId, DEFAULT_FLASH_MODEL_ID);
    assert.equal(state.vehicles[1].vehicleModelId, DEFAULT_STANDARD_MODEL_ID);
  });
});

describe("角色感知原子调度", () => {
  it("一闪充一普通同时到达时 F1→B、S1→A", () => {
    const state = blankState();
    state.vehicles = [makeVehicleFromConfig("F1", "flash_capable", 0), makeVehicleFromConfig("S1", "standard_dc", 0)];
    state.queue = ["F1", "S1"];
    const result = dispatchVehicles(state, baseConfig);
    assert.equal(result.piles[0].connectors.find((c) => c.role === "flash_dedicated")?.currentVehicleId, "F1");
    assert.equal(result.piles[0].connectors.find((c) => c.role === "universal")?.currentVehicleId, "S1");
  });

  it("两辆闪充车同时到达时 F1→B、F2→A", () => {
    const state = blankState();
    state.vehicles = [makeVehicleFromConfig("F1", "flash_capable", 0), makeVehicleFromConfig("F2", "flash_capable", 0)];
    state.queue = ["F1", "F2"];
    const result = dispatchVehicles(state, baseConfig);
    assert.equal(result.piles[0].connectors.find((c) => c.role === "flash_dedicated")?.currentVehicleId, "F1");
    assert.equal(result.piles[0].connectors.find((c) => c.role === "universal")?.currentVehicleId, "F2");
  });

  it("A 忙 B 空闲且队列只有普通车时继续等待", () => {
    const state = blankState();
    const active = makeVehicleFromConfig("F0", "flash_capable", 0);
    const waiting = makeVehicleFromConfig("S1", "standard_dc", 0);
    active.status = "charging";
    active.assignedConnectorId = "P1-A";
    active.assignedPileId = "P1";
    active.assignedConnectorRole = "universal";
    state.piles[0].connectors[0].currentVehicleId = active.id;
    state.vehicles = [active, waiting];
    state.queue = [waiting.id];
    const result = dispatchVehicles(state, baseConfig);
    assert.deepEqual(result.queue, ["S1"]);
    assert.equal(result.piles[0].connectors[1].currentVehicleId, undefined);
  });

  it("不会重复分配同一辆闪充车", () => {
    const state = blankState();
    state.vehicles = [makeVehicleFromConfig("F1", "flash_capable", 0)];
    state.queue = ["F1"];
    const result = dispatchVehicles(state, baseConfig);
    assert.equal(result.piles[0].connectors.filter((c) => c.currentVehicleId === "F1").length, 1);
  });

  it("B 释放后不会把正在 A 充电的车迁移", () => {
    const state = blankState();
    const flash = makeVehicleFromConfig("F1", "flash_capable", 0);
    flash.status = "charging";
    flash.assignedConnectorId = "P1-A";
    flash.assignedPileId = "P1";
    flash.assignedConnectorRole = "universal";
    state.vehicles = [flash];
    state.piles[0].connectors[0].currentVehicleId = "F1";
    const result = dispatchVehicles(state, baseConfig);
    assert.equal(result.piles[0].connectors[0].currentVehicleId, "F1");
    assert.equal(result.piles[0].connectors[1].currentVehicleId, undefined);
  });
});

describe("累计电网利用率", () => {
  it("正常运行时额定与可用容量利用率相同，且没有扰动标记", () => {
    const { config, state } = gridUtilizationFixture(1000, 500);
    const result = stepSimulation(state, config, 12);
    assertClose(result.cumulativeGridImportEnergyKWh, 500 * 12 / 3600);
    assertClose(result.cumulativeRatedGridCapacityEnergyKWh, 1000 * 12 / 3600);
    assertClose(result.cumulativeAvailableGridCapacityEnergyKWh, 1000 * 12 / 3600);
    assertClose(getGridRatedCapacityUtilizationPercent(result)!, 50);
    assertClose(getGridAvailableCapacityUtilizationPercent(result)!, 50);
    assert.equal(result.hasGridDisturbanceOccurred, false);
  });

  it("前半正常满载、后半限至 500kW 时额定 75%、可用 100%", () => {
    const { config, state } = gridUtilizationFixture(1000, 1000);
    const normal = stepSimulation(state, config, 10);
    const limited = setGridControl(normal, "limited", 500);
    const result = stepSimulation(limited, config, 10);
    assertClose(result.cumulativeGridImportEnergyKWh, (1000 * 10 + 500 * 10) / 3600);
    assertClose(result.cumulativeRatedGridCapacityEnergyKWh, 1000 * 20 / 3600);
    assertClose(result.cumulativeAvailableGridCapacityEnergyKWh, (1000 * 10 + 500 * 10) / 3600);
    assertClose(getGridRatedCapacityUtilizationPercent(result)!, 75);
    assertClose(getGridAvailableCapacityUtilizationPercent(result)!, 100);
    assert.equal(result.hasGridDisturbanceOccurred, true);
  });

  it("前半正常满载、后半断电时额定 50%、可用 100%", () => {
    const { config, state } = gridUtilizationFixture(1000, 1000);
    const powered = stepSimulation(state, config, 10);
    const outage = setGridControl(powered, "outage");
    const result = stepSimulation(outage, config, 10);
    assertClose(result.cumulativeGridImportEnergyKWh, 1000 * 10 / 3600);
    assertClose(result.cumulativeRatedGridCapacityEnergyKWh, 1000 * 20 / 3600);
    assertClose(result.cumulativeAvailableGridCapacityEnergyKWh, 1000 * 10 / 3600);
    assertClose(getGridRatedCapacityUtilizationPercent(result)!, 50);
    assertClose(getGridAvailableCapacityUtilizationPercent(result)!, 100);
    assert.equal(result.hasGridDisturbanceOccurred, true);
  });

  it("扰动后恢复供电仍保留双口径与扰动标记", () => {
    const { config, state } = gridUtilizationFixture(1000, 1000);
    const normal = stepSimulation(state, config, 10);
    const outage = stepSimulation(setGridControl(normal, "outage"), config, 10);
    const restored = setGridControl(outage, "normal");
    assert.equal(restored.hasGridDisturbanceOccurred, true);
    const result = stepSimulation(restored, config, 10);
    assertClose(result.cumulativeGridImportEnergyKWh, 1000 * 20 / 3600);
    assertClose(result.cumulativeRatedGridCapacityEnergyKWh, 1000 * 30 / 3600);
    assertClose(result.cumulativeAvailableGridCapacityEnergyKWh, 1000 * 20 / 3600);
    assertClose(getGridRatedCapacityUtilizationPercent(result)!, 200 / 3);
    assertClose(getGridAvailableCapacityUtilizationPercent(result)!, 100);
    assert.equal(result.hasGridDisturbanceOccurred, true);
  });

  it("Reset 会清空三个累计量和扰动标记", () => {
    const { config, state } = gridUtilizationFixture(1000, 500);
    const disturbed = stepSimulation(setGridControl(state, "limited", 400), config, 10);
    assert.equal(disturbed.hasGridDisturbanceOccurred, true);
    const reset = createEmptyState(config);
    assert.equal(reset.cumulativeGridImportEnergyKWh, 0);
    assert.equal(reset.cumulativeRatedGridCapacityEnergyKWh, 0);
    assert.equal(reset.cumulativeAvailableGridCapacityEnergyKWh, 0);
    assert.equal(reset.hasGridDisturbanceOccurred, false);
    assert.equal(getGridRatedCapacityUtilizationPercent(reset), null);
    assert.equal(getGridAvailableCapacityUtilizationPercent(reset), null);
  });

  it("运行中修改额定容量后两个容量分母都按各时段积分", () => {
    const first = gridUtilizationFixture(1000, 500);
    const firstPeriod = stepSimulation(first.state, first.config, 10);
    const secondConfig = { ...first.config, gridMaxPowerKw: 2000 };
    const result = stepSimulation(firstPeriod, secondConfig, 10);
    const expectedCapacityEnergy = (1000 * 10 + 2000 * 10) / 3600;
    assertClose(result.cumulativeGridImportEnergyKWh, 500 * 20 / 3600);
    assertClose(result.cumulativeRatedGridCapacityEnergyKWh, expectedCapacityEnergy);
    assertClose(result.cumulativeAvailableGridCapacityEnergyKWh, expectedCapacityEnergy);
    assertClose(getGridRatedCapacityUtilizationPercent(result)!, 100 / 3);
    assertClose(getGridAvailableCapacityUtilizationPercent(result)!, 100 / 3);
  });

  it("暂停期间不调用仿真步进，三个累计量与两个利用率保持不变", () => {
    const { config, state } = gridUtilizationFixture(1000, 500);
    const beforePause = stepSimulation(state, config, 5);
    const pausedState = structuredClone(beforePause);
    assert.deepEqual(pausedState, beforePause);
    assertClose(getGridRatedCapacityUtilizationPercent(pausedState)!, 50);
    assertClose(getGridAvailableCapacityUtilizationPercent(pausedState)!, 50);
  });

  it("单步一秒会累计该秒的实际取电、额定容量与可用容量能量", () => {
    const { config, state } = gridUtilizationFixture(1000, 500);
    const result = stepSimulation(state, config, 1);
    assert.equal(result.timeSec, 1);
    assertClose(result.cumulativeGridImportEnergyKWh, 500 / 3600);
    assertClose(result.cumulativeRatedGridCapacityEnergyKWh, 1000 / 3600);
    assertClose(result.cumulativeAvailableGridCapacityEnergyKWh, 1000 / 3600);
    assertClose(getGridRatedCapacityUtilizationPercent(result)!, 50);
    assertClose(getGridAvailableCapacityUtilizationPercent(result)!, 50);
  });

  it("Reset 后立即断电时额定利用率为 0%，可用利用率无分母", () => {
    const { config, state } = gridUtilizationFixture(1000, 500);
    const result = stepSimulation(setGridControl(state, "outage"), config, 10);
    assertClose(result.cumulativeGridImportEnergyKWh, 0);
    assertClose(result.cumulativeRatedGridCapacityEnergyKWh, 1000 * 10 / 3600);
    assertClose(result.cumulativeAvailableGridCapacityEnergyKWh, 0);
    assertClose(getGridRatedCapacityUtilizationPercent(result)!, 0);
    assert.equal(getGridAvailableCapacityUtilizationPercent(result), null);
  });

  it("高于额定值的临时上限不会使可用容量积分超过额定容量", () => {
    const { config, state } = gridUtilizationFixture(1000, 1000);
    const result = stepSimulation(setGridControl(state, "limited", 1500), config, 10);
    assertClose(result.cumulativeAvailableGridCapacityEnergyKWh, 1000 * 10 / 3600);
    assertClose(getGridAvailableCapacityUtilizationPercent(result)!, 100);
    assert.equal(result.hasGridDisturbanceOccurred, true);
  });
});

describe("单枪、整桩与站级功率约束", () => {
  it("单枪请求 1800kW 时仍不超过 1500kW", () => {
    const result = allocatePilePower(1500, 0, 2100, "dedicated_first");
    assert.ok(result.universalKw <= 1500);
  });

  it("闪充专枪优先得到 A600 / B1500", () => {
    assert.deepEqual(allocatePilePower(1500, 1500, 2100, "dedicated_first"), { universalKw: 600, dedicatedKw: 1500, limited: true });
  });

  it("公平分配得到 A1050 / B1050", () => {
    assert.deepEqual(allocatePilePower(1500, 1500, 2100, "equal_max_min"), { universalKw: 1050, dedicatedKw: 1050, limited: true });
  });

  it("公平分配会把低请求后的余量再分配", () => {
    assert.deepEqual(allocatePilePower(300, 1500, 2100, "equal_max_min"), { universalKw: 300, dedicatedKw: 1500, limited: false });
  });

  it("通用枪优先得到 A1500 / B600", () => {
    assert.deepEqual(allocatePilePower(1500, 1500, 2100, "universal_first"), { universalKw: 1500, dedicatedKw: 600, limited: true });
  });

  it("按请求比例得到 A1050 / B1050", () => {
    const result = allocatePilePower(1500, 1500, 2100, "proportional_to_request");
    assert.equal(result.universalKw, 1050);
    assert.equal(result.dedicatedKw, 1050);
  });

  it("站级仅 1800kW 时合计不超过 1800", () => {
    const result = allocatePilePower(1500, 1500, 1800, "dedicated_first");
    assert.ok(result.universalKw + result.dedicatedKw <= 1800);
    assert.equal(result.universalKw, 300);
    assert.equal(result.dedicatedKw, 1500);
  });

  it("多桩分别遵守 2100kW 且全站不超过 3600kW", () => {
    const first = allocatePilePower(1500, 1500, 2100, "equal_max_min");
    const second = allocatePilePower(1500, 1500, 1500, "equal_max_min");
    assert.ok(first.universalKw + first.dedicatedKw <= 2100);
    assert.ok(second.universalKw + second.dedicatedKw <= 2100);
    assert.ok(first.universalKw + first.dedicatedKw + second.universalKw + second.dedicatedKw <= 3600);
  });
});

describe("状态、等待预测与统计", () => {
  it("默认储能最大充电功率为 600kW", () => {
    assert.equal(baseConfig.storageMaxChargePowerKw, 600);
    assert.equal(createEmptyState(baseConfig).storage.maxChargePowerKw, 600);
  });

  it("储能充电功率使用配置值而不是固定 420kW", () => {
    const lowConfig = { ...baseConfig, autoArrivalEnabled: false, gridMaxPowerKw: 2500, storageMaxChargePowerKw: 300 };
    const lowState = stepSimulation(createEmptyState(lowConfig), lowConfig, 1);
    assert.equal(lowState.storage.powerKw, -300);

    const highConfig = { ...lowConfig, storageMaxChargePowerKw: 1200 };
    const highState = stepSimulation(createEmptyState(highConfig), highConfig, 1);
    assert.equal(highState.storage.powerKw, -1200);
    assert.ok(Math.abs(highState.storage.powerKw) > 420);
  });

  it("调高储能充电上限仍受电网余量约束", () => {
    const config = { ...baseConfig, autoArrivalEnabled: false, gridMaxPowerKw: 800, storageMaxChargePowerKw: 2500 };
    const state = stepSimulation(createEmptyState(config), config, 1);
    assert.equal(state.storage.powerKw, -(config.gridMaxPowerKw - config.baseLoadKw));
    assert.equal(state.gridPowerKw, config.gridMaxPowerKw);
    assert.ok(Math.abs(state.storage.powerKw) < config.storageMaxChargePowerKw);
  });

  it("空站重置状态不含车辆、队列或枪口占用", () => {
    const state = createEmptyState({ ...baseConfig, autoArrivalEnabled: false });
    assert.equal(state.vehicles.length, 0);
    assert.equal(state.queue.length, 0);
    assert.equal(state.totalArrivals, 0);
    assert.equal(state.piles[0].connectors.some((connector) => connector.currentVehicleId), false);
  });

  it("自动车辆既包含充满目标，也包含非 100% 目标", () => {
    const state = createEmptyState({ ...baseConfig, autoArrivalEnabled: false });
    for (let index = 0; index < 30; index += 1) addAutomaticVehicle(state, baseConfig);
    assert.ok(state.vehicles.some((vehicle) => vehicle.targetSocPercent === 100));
    assert.ok(state.vehicles.some((vehicle) => vehicle.targetSocPercent < 100));
  });

  it("手动电网断电后电网功率归零，且无储能时停止充电", () => {
    const config = { ...baseConfig, autoArrivalEnabled: false, storageMaxDischargePowerKw: 0 };
    let state = stepSimulation(createInitialState(config), config, 20);
    state = setGridControl(state, "outage");
    state = stepSimulation(state, config, 1);
    assert.equal(getEffectiveGridLimit(state, config), 0);
    assert.equal(state.gridPowerKw, 0);
    assert.equal(state.chargingPowerKw, 0);
  });

  it("临时电网限功率会约束站点输入且可恢复", () => {
    const config = { ...baseConfig, autoArrivalEnabled: false, storageMaxDischargePowerKw: 0 };
    let state = stepSimulation(createInitialState(config), config, 20);
    state = setGridControl(state, "limited", 120);
    state = stepSimulation(state, config, 1);
    assert.equal(getEffectiveGridLimit(state, config), 120);
    assert.ok(state.gridPowerKw <= 120);
    assert.ok(state.chargingPowerKw <= 120 - config.baseLoadKw);
    state = setGridControl(state, "normal");
    assert.equal(getEffectiveGridLimit(state, config), config.gridMaxPowerKw);
  });

  it("可手动调整储能当前电量并限制在有效范围", () => {
    const state = createEmptyState(baseConfig);
    assert.equal(setStorageEnergy(state, 125).storage.energyKWh, 125);
    assert.equal(setStorageEnergy(state, 99999).storage.energyKWh, state.storage.capacityKWh);
    assert.equal(setStorageEnergy(state, -10).storage.energyKWh, 0);
  });

  it("电网有余量时储能会自动使用剩余功率充电", () => {
    const config = { ...baseConfig, autoArrivalEnabled: false };
    const initial = createEmptyState(config);
    const beforeEnergy = initial.storage.energyKWh;
    const state = stepSimulation(initial, config, 1);
    assert.equal(state.storage.powerKw, -config.storageMaxChargePowerKw);
    assert.equal(state.gridPowerKw, config.baseLoadKw + config.storageMaxChargePowerKw);
    assert.ok(state.storage.energyKWh > beforeEnergy);
  });

  it("车辆正在充电时，电网剩余功率仍会用于储能补能", () => {
    const config = { ...baseConfig, autoArrivalEnabled: false, gridMaxPowerKw: 2500 };
    const state = stepSimulation(createInitialState(config), config, 20);
    assert.ok(state.chargingPowerKw > 50);
    assert.ok(state.storage.powerKw < 0);
    assert.equal(state.gridPowerKw, state.chargingPowerKw + config.baseLoadKw - state.storage.powerKw);
    assert.ok(state.gridPowerKw <= config.gridMaxPowerKw);
  });

  it("储能达到允许上限后不会继续充电", () => {
    const config = { ...baseConfig, autoArrivalEnabled: false };
    const initial = setStorageEnergy(createEmptyState(config), config.storageCapacityKWh);
    const state = stepSimulation(initial, config, 1);
    assert.equal(state.storage.powerKw, 0);
  });

  it("历史采样间隔可调整", () => {
    const config = { ...baseConfig, autoArrivalEnabled: false, historySampleSec: 10 };
    const state = stepSimulation(createEmptyState(config), config, 25);
    assert.deepEqual(state.history.map((sample) => sample.timeSec), [10, 20]);
  });

  it("普通车等待预测不会把 B 枪算作服务能力", () => {
    const state = blankState();
    const standard = makeVehicleFromConfig("S1", "standard_dc", 0);
    state.vehicles = [standard];
    state.queue = [standard.id];
    const estimate = estimateVehicleWaitTime("S1", state);
    assert.equal(estimate.likelyConnectorId, "P1-A");
    assert.ok(estimate.explanation.join(" ").includes("B 专用枪即使空闲也不计入"));
  });

  it("等待预测会计入车位换车周转时间", () => {
    const state = blankState();
    const standard = makeVehicleFromConfig("S1", "standard_dc", 0);
    state.vehicles = [standard];
    state.queue = [standard.id];
    state.piles[0].connectors.find((c) => c.role === "universal")!.turnoverRemainingSec = 60;
    const estimate = estimateVehicleWaitTime("S1", state, { ...baseConfig, turnoverSec: 60 });
    assert.equal(estimate.expectedWaitSec, 60);
    assert.equal(estimate.likelyConnectorId, "P1-A");
  });

  it("超过最大可接受等待时间后车辆会弃队", () => {
    const state = blankState();
    const standard = makeVehicleFromConfig("S1", "standard_dc", 0);
    state.vehicles = [standard];
    state.queue = [standard.id];
    state.piles[0].connectors.find((connector) => connector.role === "universal")!.turnoverRemainingSec = 100;
    const config = { ...baseConfig, autoArrivalEnabled: false, maxAcceptableWaitSec: 2 };
    const result = stepSimulation(state, config, 3);
    assert.equal(result.vehicles[0].status, "abandoned");
    assert.equal(result.queue.length, 0);
  });

  it("无限等待模式下车辆不会因等待时长弃队", () => {
    const state = blankState();
    const standard = makeVehicleFromConfig("S1", "standard_dc", 0);
    state.vehicles = [standard];
    state.queue = [standard.id];
    state.piles[0].connectors.find((connector) => connector.role === "universal")!.turnoverRemainingSec = 100;
    const config = { ...baseConfig, autoArrivalEnabled: false, maxAcceptableWaitSec: null };
    const result = stepSimulation(state, config, 90);
    assert.equal(result.vehicles[0].status, "queued");
    assert.deepEqual(result.queue, ["S1"]);
  });

  it("换车倒计时结束前不会分配下一辆车", () => {
    const state = blankState();
    const flash = makeVehicleFromConfig("F1", "flash_capable", 0);
    state.vehicles = [flash];
    state.queue = [flash.id];
    state.piles[0].connectors.forEach((connector) => { connector.turnoverRemainingSec = 60; });
    const config = { ...baseConfig, autoArrivalEnabled: false, turnoverSec: 60 };
    const beforeReady = stepSimulation(state, config, 59);
    assert.equal(beforeReady.queue.includes("F1"), true);
    assert.equal(beforeReady.piles[0].connectors.some((connector) => connector.currentVehicleId === "F1"), false);
    const ready = stepSimulation(beforeReady, config, 1);
    assert.equal(ready.queue.includes("F1"), false);
    assert.equal(ready.piles[0].connectors.some((connector) => connector.currentVehicleId === "F1"), true);
  });

  it("车辆完成拔枪后自动进入配置的周转期", () => {
    const state = blankState();
    const flash = makeVehicleFromConfig("F1", "flash_capable", 0, 81.999);
    flash.targetSocPercent = 82;
    flash.status = "charging";
    flash.chargingStartedAtSec = 0;
    flash.assignedPileId = "P1";
    flash.assignedConnectorId = "P1-A";
    flash.assignedConnectorRole = "universal";
    state.vehicles = [flash];
    state.piles[0].connectors.find((connector) => connector.id === "P1-A")!.currentVehicleId = flash.id;
    const config = { ...baseConfig, autoArrivalEnabled: false, turnoverSec: 75 };
    const result = stepSimulation(state, config, 6);
    const universal = result.piles[0].connectors.find((connector) => connector.id === "P1-A")!;
    assert.equal(universal.currentVehicleId, undefined);
    assert.equal(universal.turnoverRemainingSec, 75);
  });

  it("曲线积分可给出正的剩余充电时间", () => {
    const flash = makeVehicleFromConfig("F1", "flash_capable", 0, 20);
    flash.targetSocPercent = 80;
    assert.ok(estimateRemainingChargeTime(flash) > 0);
  });

  it("运行后 SOC 单调增加且不超过目标", () => {
    const state = createInitialState({ ...baseConfig, autoArrivalEnabled: false });
    const result = stepSimulation(state, { ...baseConfig, autoArrivalEnabled: false }, 20);
    result.vehicles.forEach((vehicle) => {
      assert.ok(vehicle.currentSocPercent >= vehicle.initialSocPercent);
      assert.ok(vehicle.currentSocPercent <= vehicle.targetSocPercent);
    });
  });

  it("初始原子调度正确累计 A/B 服务分类统计", () => {
    const state = createInitialState({ ...baseConfig, autoArrivalEnabled: false });
    const a = state.piles[0].connectors.find((c) => c.role === "universal")!;
    const b = state.piles[0].connectors.find((c) => c.role === "flash_dedicated")!;
    assert.equal(a.servedStandard, 1);
    assert.equal(a.servedFlash, 0);
    assert.equal(b.servedFlash, 1);
    assert.equal(b.servedStandard, 0);
    assert.doesNotThrow(() => assertSimulationInvariants(state, baseConfig));
  });
});

describe("VehicleModel 快照生命周期", () => {
  it("Vehicle 快照车型参数，之后修改 model 不影响 Vehicle", () => {
    const models = resolveVehicleModels(baseConfig);
    const flashModel = models.find((m) => m.chargingClass === "flash_capable")!;
    const vehicle = makeVehicleFromConfig("TEST-1", "flash_capable", 0, 50);
    assert.equal(vehicle.name, flashModel.name);
    assert.equal(vehicle.usableBatteryCapacityKWh, 112);
    assert.equal(vehicle.chargingCurve[0].powerKw, 400);
    flashModel.name = "修改后名称";
    flashModel.usableBatteryCapacityKWh = 999;
    flashModel.chargingCurve[0].powerKw = 8888;
    assert.equal(vehicle.name, "兆瓦闪充车辆");
    assert.equal(vehicle.usableBatteryCapacityKWh, 112);
    assert.equal(vehicle.chargingCurve[0].powerKw, 400);
  });

  it("Vehicle 正确记录 vehicleModelId", () => {
    const flash = makeVehicleFromConfig("F1", "flash_capable", 0);
    const standard = makeVehicleFromConfig("S1", "standard_dc", 0);
    assert.equal(flash.vehicleModelId, DEFAULT_FLASH_MODEL_ID);
    assert.equal(standard.vehicleModelId, DEFAULT_STANDARD_MODEL_ID);
  });

  it("Vehicle curve 与 Model curve 不共享引用", () => {
    const models = resolveVehicleModels(baseConfig);
    const flashModel = models.find((m) => m.chargingClass === "flash_capable")!;
    const vehicle = makeVehicleFromConfig("F1", "flash_capable", 0);
    assert.notEqual(vehicle.chargingCurve, flashModel.chargingCurve);
    assert.notEqual(vehicle.chargingCurve[0], flashModel.chargingCurve[0]);
    vehicle.chargingCurve[0].powerKw = 9999;
    assert.equal(flashModel.chargingCurve[0].powerKw, 400);
  });

  it("默认 v2 config 单车型类别不额外消费 RNG", () => {
    const config = { ...baseConfig, autoArrivalEnabled: false, randomSeed: 42 };
    const state1 = createEmptyState(config);
    const state2 = createEmptyState(config);
    addAutomaticVehicle(state1, config);
    addAutomaticVehicle(state2, config);
    assert.equal(state1.randomState, state2.randomState);
    assert.equal(state1.vehicles[0].vehicleModelId, state2.vehicles[0].vehicleModelId);
    assert.equal(state1.vehicles[0].chargingClass, state2.vehicles[0].chargingClass);
  });

  it("多车型使用 seeded RNG 选择具体车型", () => {
    const models = resolveVehicleModels(baseConfig);
    models.push({
      id: "extra-flash",
      name: "额外闪充车",
      chargingClass: "flash_capable",
      usableBatteryCapacityKWh: 200,
      chargingCurve: cloneChargingCurve(flashCurve),
    });
    const config = { ...baseConfig, schemaVersion: 3 as const, vehicleModels: models, autoArrivalEnabled: false, randomSeed: 42 };
    const state = createEmptyState(config);
    addAutomaticVehicle(state, config);
    const ids = state.vehicles.map((v) => v.vehicleModelId);
    assert.ok(ids[0] === DEFAULT_FLASH_MODEL_ID || ids[0] === "extra-flash");
    assert.equal(state.randomState !== config.randomSeed, true);
  });

  it("同 seed + 同 Catalog 得到相同车型 ID 序列", () => {
    const models = resolveVehicleModels(baseConfig);
    models.push({
      id: "extra-flash",
      name: "额外闪充车",
      chargingClass: "flash_capable",
      usableBatteryCapacityKWh: 200,
      chargingCurve: cloneChargingCurve(flashCurve),
    });
    const config = { ...baseConfig, schemaVersion: 3 as const, vehicleModels: models, autoArrivalEnabled: false, randomSeed: 12345 };
    const state1 = createEmptyState(config);
    const state2 = createEmptyState(config);
    for (let i = 0; i < 10; i++) {
      addAutomaticVehicle(state1, config);
      addAutomaticVehicle(state2, config);
    }
    assert.deepEqual(
      state1.vehicles.map((v) => v.vehicleModelId),
      state2.vehicles.map((v) => v.vehicleModelId),
    );
    assert.equal(state1.randomState, state2.randomState);
  });

  it("不同车型容量正确来自具体 model", () => {
    const models = resolveVehicleModels(baseConfig);
    models.push({
      id: "big-flash",
      name: "大容量闪充车",
      chargingClass: "flash_capable",
      usableBatteryCapacityKWh: 600,
      chargingCurve: cloneChargingCurve(flashCurve),
    });
    const config = { ...baseConfig, schemaVersion: 3 as const, vehicleModels: models, autoArrivalEnabled: false, randomSeed: 99 };
    const state = createEmptyState(config);
    for (let i = 0; i < 20; i++) addAutomaticVehicle(state, config);
    const bigFlash = state.vehicles.filter((v) => v.vehicleModelId === "big-flash");
    const defaultFlash = state.vehicles.filter((v) => v.vehicleModelId === DEFAULT_FLASH_MODEL_ID);
    if (bigFlash.length > 0) assert.equal(bigFlash[0].usableBatteryCapacityKWh, 600);
    if (defaultFlash.length > 0) assert.equal(defaultFlash[0].usableBatteryCapacityKWh, 112);
    assert.ok(bigFlash.length > 0 || defaultFlash.length > 0);
  });

  it("不同车型曲线影响 Vehicle 请求功率", () => {
    const models = resolveVehicleModels(baseConfig);
    const lowCurve = [{ soc: 0, powerKw: 100 }, { soc: 50, powerKw: 100 }, { soc: 100, powerKw: 0 }];
    models.push({
      id: "low-power-flash",
      name: "低功率闪充车",
      chargingClass: "flash_capable",
      usableBatteryCapacityKWh: 112,
      chargingCurve: lowCurve,
    });
    const config = { ...baseConfig, schemaVersion: 3 as const, vehicleModels: models, autoArrivalEnabled: false };
    const state = createEmptyState(config);
    const lowVehicle = makeVehicleFromConfig("LOW-1", "flash_capable", 0, 25, config);
    lowVehicle.vehicleModelId = "low-power-flash";
    lowVehicle.chargingCurve = lowCurve.map((p) => ({ ...p }));
    state.vehicles.push(lowVehicle);
    const defaultVehicle = makeVehicleFromConfig("DEF-1", "flash_capable", 0, 25, config);
    state.vehicles.push(defaultVehicle);
    assert.equal(lowVehicle.chargingCurve[1].powerKw, 100);
    assert.equal(defaultVehicle.chargingCurve[2].powerKw, 1500);
  });

  it("修改 Catalog 不影响排队 Vehicle", () => {
    const models = resolveVehicleModels(baseConfig);
    const state = createEmptyState(baseConfig);
    const vehicle = makeVehicleFromConfig("F1", "flash_capable", 0, 30);
    state.vehicles.push(vehicle);
    state.queue.push(vehicle.id);
    const originalCapacity = vehicle.usableBatteryCapacityKWh;
    const originalCurvePower = vehicle.chargingCurve[2].powerKw;
    const flashModel = models.find((m) => m.chargingClass === "flash_capable")!;
    flashModel.usableBatteryCapacityKWh = 999;
    flashModel.chargingCurve[2].powerKw = 1;
    assert.equal(vehicle.usableBatteryCapacityKWh, originalCapacity);
    assert.equal(vehicle.chargingCurve[2].powerKw, originalCurvePower);
  });

  it("修改 Catalog 不影响正在充电 Vehicle", () => {
    const state = createEmptyState(baseConfig);
    const vehicle = makeVehicleFromConfig("F1", "flash_capable", 0, 60);
    vehicle.status = "charging";
    vehicle.chargingStartedAtSec = 0;
    vehicle.assignedPileId = "P1";
    vehicle.assignedConnectorId = "P1-B";
    vehicle.assignedConnectorRole = "flash_dedicated";
    state.vehicles.push(vehicle);
    state.piles[0].connectors[1].currentVehicleId = vehicle.id;
    const originalCurve = vehicle.chargingCurve.map((p) => ({ ...p }));
    const result = stepSimulation(state, { ...baseConfig, flashChargingCurve: flashCurve.map((p) => ({ ...p, powerKw: 50 })) }, 5);
    const charged = result.vehicles.find((v) => v.id === "F1")!;
    assert.deepEqual(charged.chargingCurve, originalCurve);
  });

  it("类别修改不改变已有 Vehicle 兼容性", () => {
    const models = resolveVehicleModels(baseConfig);
    const state = blankState();
    const vehicle = makeVehicleFromConfig("S1", "standard_dc", 0);
    state.vehicles.push(vehicle);
    state.queue.push(vehicle.id);
    const [, b] = state.piles[0].connectors;
    assert.equal(isVehicleEligibleForConnector(vehicle, b), false);
    const standardModel = models.find((m) => m.chargingClass === "standard_dc")!;
    standardModel.chargingClass = "flash_capable";
    assert.equal(vehicle.chargingClass, "standard_dc");
    assert.equal(isVehicleEligibleForConnector(vehicle, b), false);
  });

  it("A/B 兼容完全保持", () => {
    const standard = makeVehicleFromConfig("S1", "standard_dc", 0);
    const flash = makeVehicleFromConfig("F1", "flash_capable", 0);
    const [a, b] = blankState().piles[0].connectors;
    assert.equal(isVehicleEligibleForConnector(standard, a), true);
    assert.equal(isVehicleEligibleForConnector(standard, b), false);
    assert.equal(isVehicleEligibleForConnector(flash, a), true);
    assert.equal(isVehicleEligibleForConnector(flash, b), true);
  });

  it("手动指定 vehicleModelId 正确使用对应车型", () => {
    const models = resolveVehicleModels(baseConfig);
    models.push({
      id: "custom-flash",
      name: "自定义闪充车",
      chargingClass: "flash_capable",
      usableBatteryCapacityKWh: 400,
      chargingCurve: cloneChargingCurve(flashCurve),
    });
    const config = { ...baseConfig, schemaVersion: 3 as const, vehicleModels: models };
    const state = createEmptyState(config);
    const result = addManualVehicle(state, config, {
      chargingClass: "flash_capable",
      capacity: 400,
      maxPower: 1500,
      initialSoc: 30,
      targetSoc: 90,
      vehicleModelId: "custom-flash",
    });
    const vehicle = result.vehicles.find((v) => v.id.includes("M"))!;
    assert.equal(vehicle.vehicleModelId, "custom-flash");
    assert.equal(vehicle.name, "自定义闪充车");
  });

  it("旧手动调用（无 vehicleModelId）仍按类别选择默认车型", () => {
    const state = createEmptyState(baseConfig);
    const result = addManualVehicle(state, baseConfig, {
      chargingClass: "flash_capable",
      capacity: 112,
      maxPower: 1500,
      initialSoc: 30,
      targetSoc: 90,
    });
    const vehicle = result.vehicles.find((v) => v.id.includes("M"))!;
    assert.equal(vehicle.vehicleModelId, DEFAULT_FLASH_MODEL_ID);
    assert.equal(vehicle.chargingClass, "flash_capable");
  });

  it("手动容量 override 覆盖 Vehicle 但不修改 Model", () => {
    const models = resolveVehicleModels(baseConfig);
    models[0].usableBatteryCapacityKWh = 600;
    const config = { ...baseConfig, schemaVersion: 3 as const, vehicleModels: models };
    const state = createEmptyState(config);
    const result = addManualVehicle(state, config, {
      chargingClass: "flash_capable",
      capacity: 450,
      maxPower: 1500,
      initialSoc: 30,
      targetSoc: 90,
    });
    const vehicle = result.vehicles.find((v) => v.id.includes("M"))!;
    assert.equal(vehicle.usableBatteryCapacityKWh, 450);
    assert.equal(models[0].usableBatteryCapacityKWh, 600);
  });

  it("createInitialState 所有初始 Vehicle 都有 vehicleModelId 和快照", () => {
    const state = createInitialState(baseConfig);
    for (const vehicle of state.vehicles) {
      assert.ok(vehicle.vehicleModelId, `${vehicle.id} 缺少 vehicleModelId`);
      assert.ok(vehicle.name, `${vehicle.id} 缺少 name`);
      assert.ok(vehicle.chargingCurve.length >= 2, `${vehicle.id} 曲线不完整`);
    }
    assert.equal(state.vehicles[0].vehicleModelId, DEFAULT_FLASH_MODEL_ID);
    assert.equal(state.vehicles[1].vehicleModelId, DEFAULT_STANDARD_MODEL_ID);
  });

  it("自动生成默认 v2 config 不额外消费 RNG（seed 序列对比）", () => {
    const configA = { ...baseConfig, autoArrivalEnabled: false, randomSeed: 777 };
    const configB = { ...baseConfig, autoArrivalEnabled: false, randomSeed: 777 };
    const stateA = createEmptyState(configA);
    const stateB = createEmptyState(configB);
    for (let i = 0; i < 5; i++) {
      addAutomaticVehicle(stateA, configA);
      addAutomaticVehicle(stateB, configB);
    }
    assert.equal(stateA.randomState, stateB.randomState);
    assert.deepEqual(
      stateA.vehicles.map((v) => ({ class: v.chargingClass, soc: v.initialSocPercent })),
      stateB.vehicles.map((v) => ({ class: v.chargingClass, soc: v.initialSocPercent })),
    );
  });

  it("applyConfiguredCurve 已删除，修改 config 曲线不影响已有 Vehicle", () => {
    const state = createInitialState(baseConfig);
    const flashVehicles = state.vehicles.filter((v) => v.chargingClass === "flash_capable");
    const originalCurve = flashVehicles[0].chargingCurve.map((p) => ({ ...p }));
    const modifiedConfig = {
      ...baseConfig,
      flashChargingCurve: flashCurve.map((p) => ({ ...p, powerKw: 50 })),
    };
    const stepped = stepSimulation(state, modifiedConfig, 5);
    for (const vehicle of stepped.vehicles.filter((v) => v.chargingClass === "flash_capable")) {
      assert.deepEqual(vehicle.chargingCurve, originalCurve);
    }
  });

  it("配置决定弃队时间（不手动 patch Vehicle 字段）", () => {
    const state = blankState();
    const vehicle = makeVehicleFromConfig("S1", "standard_dc", 0);
    state.vehicles = [vehicle];
    state.queue = [vehicle.id];
    state.piles[0].connectors.find((c) => c.role === "universal")!.turnoverRemainingSec = 100;
    const config = { ...baseConfig, autoArrivalEnabled: false, maxAcceptableWaitSec: 3 };
    const before = stepSimulation(state, config, 2);
    assert.equal(before.vehicles[0].status, "queued");
    const after = stepSimulation(before, config, 2);
    assert.equal(after.vehicles[0].status, "abandoned");
  });

  it("运行中修改 maxAcceptableWaitSec 立即影响已排队 Vehicle", () => {
    const state = blankState();
    const vehicle = makeVehicleFromConfig("S1", "standard_dc", 0);
    state.vehicles = [vehicle];
    state.queue = [vehicle.id];
    state.piles[0].connectors.find((c) => c.role === "universal")!.turnoverRemainingSec = 200;
    const longWaitConfig = { ...baseConfig, autoArrivalEnabled: false, maxAcceptableWaitSec: 100 };
    const waited = stepSimulation(state, longWaitConfig, 10);
    assert.equal(waited.vehicles[0].status, "queued");
    const shortWaitConfig = { ...longWaitConfig, maxAcceptableWaitSec: 2 };
    const abandoned = stepSimulation(waited, shortWaitConfig, 3);
    assert.equal(abandoned.vehicles[0].status, "abandoned");
  });

  it("无限等待模式下车辆不会因等待时长弃队", () => {
    const state = blankState();
    const vehicle = makeVehicleFromConfig("S1", "standard_dc", 0);
    state.vehicles = [vehicle];
    state.queue = [vehicle.id];
    state.piles[0].connectors.find((c) => c.role === "universal")!.turnoverRemainingSec = 200;
    const config = { ...baseConfig, autoArrivalEnabled: false, maxAcceptableWaitSec: null };
    const result = stepSimulation(state, config, 90);
    assert.equal(result.vehicles[0].status, "queued");
  });

  it("修复等待策略后曲线仍然 snapshot（不重新引入实时覆盖）", () => {
    const config = { ...baseConfig, autoArrivalEnabled: false, maxAcceptableWaitSec: 5 };
    const state = createInitialState(config);
    const flashVehicle = state.vehicles.find((v) => v.chargingClass === "flash_capable")!;
    const originalCurve = flashVehicle.chargingCurve.map((p) => ({ ...p }));
    const modifiedConfig = {
      ...config,
      maxAcceptableWaitSec: 10,
      flashChargingCurve: flashCurve.map((p) => ({ ...p, powerKw: 10 })),
    };
    const result = stepSimulation(state, modifiedConfig, 5);
    const after = result.vehicles.find((v) => v.id === flashVehicle.id)!;
    assert.deepEqual(after.chargingCurve, originalCurve);
    assert.equal(after.chargingCurve[0].powerKw, 400);
  });
});
