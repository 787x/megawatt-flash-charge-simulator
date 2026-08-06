import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addAutomaticVehicle,
  allocatePilePower,
  assertSimulationInvariants,
  createEmptyState,
  createInitialState,
  dispatchVehicles,
  estimateRemainingChargeTime,
  estimateVehicleWaitTime,
  getEffectiveGridLimit,
  interpolateCurve,
  isVehicleEligibleForConnector,
  setGridControl,
  setStorageEnergy,
  stepSimulation,
} from "./engine.js";
import { baseConfig, flashCurve, makeVehicle } from "./presets.js";

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

describe("充电曲线与兼容性", () => {
  it("分段线性插值正确", () => {
    assert.equal(interpolateCurve(flashCurve, 15), 1250);
    assert.equal(interpolateCurve(flashCurve, 100), 0);
  });

  it("普通车不能使用 B，闪充车可使用 A 或 B", () => {
    const state = blankState();
    const [a, b] = state.piles[0].connectors;
    const standard = makeVehicle("S1", "standard_dc", 0);
    const flash = makeVehicle("F1", "flash_capable", 0);
    assert.equal(isVehicleEligibleForConnector(standard, a), true);
    assert.equal(isVehicleEligibleForConnector(standard, b), false);
    assert.equal(isVehicleEligibleForConnector(flash, a), true);
    assert.equal(isVehicleEligibleForConnector(flash, b), true);
  });

  it("普通车默认峰值能力和曲线峰值均为 520kW", () => {
    const standard = makeVehicle("S1", "standard_dc", 0);
    assert.equal(standard.maxChargingPowerKw, 520);
    assert.equal(Math.max(...standard.chargingCurve.map((point) => point.powerKw)), 520);
  });

  it("配置中的两类曲线会写入对应车辆", () => {
    const config = {
      ...baseConfig,
      flashChargingCurve: baseConfig.flashChargingCurve.map((point) => ({ ...point, powerKw: 333 })),
      standardChargingCurve: baseConfig.standardChargingCurve.map((point) => ({ ...point, powerKw: 222 })),
    };
    const state = createInitialState(config);
    assert.equal(state.vehicles.find((vehicle) => vehicle.chargingClass === "flash_capable")?.chargingCurve[0].powerKw, 333);
    assert.equal(state.vehicles.find((vehicle) => vehicle.chargingClass === "standard_dc")?.chargingCurve[0].powerKw, 222);
  });
});

describe("角色感知原子调度", () => {
  it("一闪充一普通同时到达时 F1→B、S1→A", () => {
    const state = blankState();
    state.vehicles = [makeVehicle("F1", "flash_capable", 0), makeVehicle("S1", "standard_dc", 0)];
    state.queue = ["F1", "S1"];
    const result = dispatchVehicles(state, baseConfig);
    assert.equal(result.piles[0].connectors.find((c) => c.role === "flash_dedicated")?.currentVehicleId, "F1");
    assert.equal(result.piles[0].connectors.find((c) => c.role === "universal")?.currentVehicleId, "S1");
  });

  it("两辆闪充车同时到达时 F1→B、F2→A", () => {
    const state = blankState();
    state.vehicles = [makeVehicle("F1", "flash_capable", 0), makeVehicle("F2", "flash_capable", 0)];
    state.queue = ["F1", "F2"];
    const result = dispatchVehicles(state, baseConfig);
    assert.equal(result.piles[0].connectors.find((c) => c.role === "flash_dedicated")?.currentVehicleId, "F1");
    assert.equal(result.piles[0].connectors.find((c) => c.role === "universal")?.currentVehicleId, "F2");
  });

  it("A 忙 B 空闲且队列只有普通车时继续等待", () => {
    const state = blankState();
    const active = makeVehicle("F0", "flash_capable", 0);
    const waiting = makeVehicle("S1", "standard_dc", 0);
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
    state.vehicles = [makeVehicle("F1", "flash_capable", 0)];
    state.queue = ["F1"];
    const result = dispatchVehicles(state, baseConfig);
    assert.equal(result.piles[0].connectors.filter((c) => c.currentVehicleId === "F1").length, 1);
  });

  it("B 释放后不会把正在 A 充电的车迁移", () => {
    const state = blankState();
    const flash = makeVehicle("F1", "flash_capable", 0);
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
    const standard = makeVehicle("S1", "standard_dc", 0);
    state.vehicles = [standard];
    state.queue = [standard.id];
    const estimate = estimateVehicleWaitTime("S1", state);
    assert.equal(estimate.likelyConnectorId, "P1-A");
    assert.ok(estimate.explanation.join(" ").includes("B 专用枪即使空闲也不计入"));
  });

  it("等待预测会计入车位换车周转时间", () => {
    const state = blankState();
    const standard = makeVehicle("S1", "standard_dc", 0);
    state.vehicles = [standard];
    state.queue = [standard.id];
    state.piles[0].connectors.find((c) => c.role === "universal")!.turnoverRemainingSec = 60;
    const estimate = estimateVehicleWaitTime("S1", state, { ...baseConfig, turnoverSec: 60 });
    assert.equal(estimate.expectedWaitSec, 60);
    assert.equal(estimate.likelyConnectorId, "P1-A");
  });

  it("超过最大可接受等待时间后车辆会弃队", () => {
    const state = blankState();
    const standard = makeVehicle("S1", "standard_dc", 0);
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
    const standard = makeVehicle("S1", "standard_dc", 0);
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
    const flash = makeVehicle("F1", "flash_capable", 0);
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
    const flash = makeVehicle("F1", "flash_capable", 0, 81.999);
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
    const flash = makeVehicle("F1", "flash_capable", 0, 20);
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
