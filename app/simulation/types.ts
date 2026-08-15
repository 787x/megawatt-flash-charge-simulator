export type VehicleChargingClass = "flash_capable" | "standard_dc";
export type ConnectorRole = "universal" | "flash_dedicated";
export type GridControlMode = "normal" | "outage" | "limited";
export type VehicleStatus =
  | "scheduled"
  | "arriving"
  | "queued"
  | "moving_to_bay"
  | "connecting"
  | "charging"
  | "completed"
  | "disconnecting"
  | "departing"
  | "departed"
  | "abandoned"
  | "faulted";

export type QueueDispatchPolicy =
  | "role_aware_fcfs"
  | "standard_priority_on_universal"
  | "flash_priority"
  | "shortest_expected_session"
  | "lowest_soc_first"
  | "weighted_wait_time";

export type PilePowerAllocationPolicy =
  | "dedicated_first"
  | "equal_max_min"
  | "proportional_to_request"
  | "universal_first"
  | "custom_weighted";

export type PowerLimitReason =
  | "none"
  | "vehicle_curve"
  | "vehicle_max_power"
  | "connector_max_power"
  | "connector_policy_cap"
  | "pile_aggregate_limit"
  | "pile_allocation_policy"
  | "station_power_limit"
  | "grid_power_limit"
  | "storage_discharge_limit"
  | "storage_soc_floor";

export interface ChargingCurvePoint {
  soc: number;
  powerKw: number;
}

export interface Vehicle {
  id: string;
  name: string;
  chargingClass: VehicleChargingClass;
  status: VehicleStatus;
  usableBatteryCapacityKWh: number;
  initialSocPercent: number;
  currentSocPercent: number;
  targetSocPercent: number;
  maxChargingPowerKw: number;
  maxChargingVoltageV: number;
  maxChargingCurrentA: number;
  chargingEfficiency: number;
  batteryTemperatureC: number;
  batteryHealthPercent: number;
  chargingCurve: ChargingCurvePoint[];
  arrivalTimeSec: number;
  queuedAtSec?: number;
  chargingStartedAtSec?: number;
  completedAtSec?: number;
  departedAtSec?: number;
  maxAcceptableWaitSec: number | null;
  priority: number;
  connectorStandard: "gbt_dc" | "custom";
  assignedPileId?: string;
  assignedConnectorId?: string;
  assignedConnectorRole?: ConnectorRole;
  requestedPowerKw: number;
  actualPowerKw: number;
  deliveredEnergyKWh: number;
  limitReasons: PowerLimitReason[];
  phaseRemainingSec: number;
  timeline: { timeSec: number; status: VehicleStatus; note: string }[];
}

export interface Connector {
  id: string;
  pileId: string;
  displayName: string;
  role: ConnectorRole;
  maxPowerKw: number;
  maxVoltageV: number;
  maxCurrentA: number;
  enabled: boolean;
  strictEligibility: boolean;
  policyPowerCapKw?: number;
  currentVehicleId?: string;
  sessionId?: string;
  turnoverRemainingSec: number;
  actualPowerKw: number;
  requestedPowerKw: number;
  busySec: number;
  incompatibleIdleSec: number;
  servedFlash: number;
  servedStandard: number;
}

export interface ChargingPile {
  id: string;
  name: string;
  aggregateMaxPowerKw: number;
  enabled: boolean;
  allocationPolicy: PilePowerAllocationPolicy;
  universalWeight: number;
  flashDedicatedWeight: number;
  conversionEfficiency: number;
  connectors: Connector[];
  aggregateLimitedSec: number;
  simultaneousSec: number;
  curtailedEnergyKWh: number;
}

export interface StorageState {
  name: string;
  capacityKWh: number;
  energyKWh: number;
  minSocPercent: number;
  maxSocPercent: number;
  maxChargePowerKw: number;
  maxDischargePowerKw: number;
  chargeEfficiency: number;
  dischargeEfficiency: number;
  powerKw: number;
  cumulativeChargeKWh: number;
  cumulativeDischargeKWh: number;
}

export interface SimulationConfig {
  schemaVersion: 2;
  scenarioName: string;
  gridMaxPowerKw: number;
  baseLoadKw: number;
  stationBusMaxPowerKw: number;
  pileAggregateMaxPowerKw: number;
  connectorMaxPowerKw: number;
  universalPolicyCapKw?: number;
  flashChargingCurve: ChargingCurvePoint[];
  standardChargingCurve: ChargingCurvePoint[];
  storageCapacityKWh: number;
  storageInitialSocPercent: number;
  storageMinSocPercent: number;
  storageMaxDischargePowerKw: number;
  storageMaxChargePowerKw: number;
  queuePolicy: QueueDispatchPolicy;
  maxAcceptableWaitSec: number | null;
  pilePolicy: PilePowerAllocationPolicy;
  autoArrivalEnabled: boolean;
  arrivalRatePerHour: number;
  flashShare: number;
  randomSeed: number;
  handshakeSec: number;
  movementSec: number;
  disconnectSec: number;
  turnoverSec: number;
  historySampleSec: number;
}

export type SimulationEventType =
  | "vehicle_arrived"
  | "vehicle_queued"
  | "vehicle_assigned_to_universal"
  | "vehicle_assigned_to_flash_dedicated"
  | "vehicle_ineligible_for_connector"
  | "dedicated_connector_idle_no_eligible_vehicle"
  | "pile_aggregate_power_limited"
  | "universal_connector_serving_flash_vehicle"
  | "charging_started"
  | "charging_completed"
  | "vehicle_departed"
  | "vehicle_abandoned"
  | "storage_limit"
  | "grid_outage"
  | "grid_restored"
  | "grid_limit_changed"
  | "storage_energy_adjusted";

export interface SimulationEvent {
  id: string;
  timeSec: number;
  type: SimulationEventType;
  message: string;
  level: "info" | "warning" | "success";
}

export interface HistorySample {
  timeSec: number;
  chargingPowerKw: number;
  gridPowerKw: number;
  storagePowerKw: number;
  storageSocPercent: number;
  storageEnergyKWh: number;
  queueLength: number;
  chargingCount: number;
  powerA: number;
  powerB: number;
}

export interface SimulationState {
  timeSec: number;
  vehicles: Vehicle[];
  queue: string[];
  piles: ChargingPile[];
  storage: StorageState;
  gridControl: {
    mode: GridControlMode;
    temporaryLimitKw: number;
  };
  gridPowerKw: number;
  chargingPowerKw: number;
  cumulativeGridImportEnergyKWh: number;
  cumulativeRatedGridCapacityEnergyKWh: number;
  randomState: number;
  nextAutoArrivalSec: number;
  events: SimulationEvent[];
  history: HistorySample[];
  totalArrivals: number;
  invariantErrors: string[];
}

export interface WaitEstimate {
  expectedWaitSec: number;
  likelyConnectorId?: string;
  confidence: "high" | "medium" | "low";
  explanation: string[];
}

export interface AllocationResult {
  universalKw: number;
  dedicatedKw: number;
  limited: boolean;
}
