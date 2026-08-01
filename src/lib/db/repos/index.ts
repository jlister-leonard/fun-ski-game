/**
 * @file The repository surface (task graph node **V6**).
 *
 * ```ts
 * import { foodLogs, weights, workoutSets } from '@/lib/db/repos';
 *
 * const logs   = await foodLogs.getForDate('2026-07-26');
 * const series = await weights.getSeries('2026-05-01', '2026-07-26');
 * const sets   = await workoutSets.getForSession(sessionId);
 * ```
 *
 * Every one of these is browser-only and throws
 * {@link import('../../vault/session').VaultLockedError} when the vault is
 * locked. Guard the *call site*, not the import — importing this module during
 * a prerender is inert.
 */

export {
  Repo,
  SingletonRepo,
  VaultLockedError,
  type BulkResult,
  type ListOptions,
  type NewRecord,
  type RecordPatch,
  type UpsertResult,
} from './base';

export { observe, subscribeQuery } from './live';

export { GoalRepo, ProfileRepo, SettingsRepo, goals, profiles, settings } from './profile';

export {
  MeasurementRepo,
  WeightRepo,
  measurements,
  weights,
  type WeightSeriesPoint,
} from './body';

export {
  FoodLogRepo,
  FoodRepo,
  MealRepo,
  RecipeRepo,
  ZERO_NUTRIENTS,
  foodLogs,
  foods,
  meals,
  recipes,
  scaleNutrients,
  sumNutrients,
} from './nutrition';

export {
  ExerciseRepo,
  MesocycleRepo,
  PersonalRecordRepo,
  ProgramRepo,
  WorkoutSessionRepo,
  WorkoutSetRepo,
  exercises,
  mesocycles,
  personalRecords,
  programs,
  workoutSessions,
  workoutSets,
} from './training';

export {
  ActivityRepo,
  HealthMetricRepo,
  ReadinessRepo,
  SleepRepo,
  activities,
  addDays,
  healthMetrics,
  readiness,
  sleep,
  toDateKey,
  type MetricPoint,
} from './health';

export { LabRecordRepo, labRecords, type NewLabRecord } from './labs';

export {
  IngestLogRepo,
  InsightRepo,
  IntegrationRepo,
  ingestLog,
  insights,
  integrations,
} from './system';
