/**
 * @file Public surface of the vault (nodes **V3** + **V5**).
 *
 * ```ts
 * import { initializeVault, unlock, lock, getState, subscribe } from '@/lib/vault';
 * ```
 *
 * Headless: no React, no components, no DOM rendering. Everything that touches
 * `window`, `document` or `indexedDB` does so lazily inside a function, so
 * importing this module during a Next.js prerender is inert.
 */

export {
  VaultAlreadyInitializedError,
  VaultNotInitializedError,
  addRecoveryCode,
  assessPassphrase,
  changePassphrase,
  configureAutoLock,
  getState,
  getStatus,
  initializeVault,
  invalidateKeyringCache,
  isInitialized,
  isUnlocked,
  loadKeyring,
  lock,
  registerSecretWrapping,
  removeWrapping,
  replaceKeyring,
  startAutoLock,
  stopAutoLock,
  subscribe,
  unlock,
  unlockWithRecoveryCode,
  unlockWithSecret,
  VaultLockedError,
  type AutoLockConfig,
  type InitializeOptions,
  type InitializeResult,
  type PassphraseAssessment,
  type VaultEvent,
  type VaultListener,
  type VaultState,
  type VaultStatus,
} from './vault';

export {
  DEFAULT_AUTOLOCK,
  getAutoLockConfig,
  isAutoLockRunning,
  msUntilIdleLock,
  noteActivity,
} from './autolock';

export { clearListeners, type LockReason } from './events';

export { activeWrappingId, getKeys, requireKeys, unlockedAt } from './session';

export {
  BACKUP_EXTENSION,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BackupFormatError,
  daysSinceLastBackup,
  exportAndVerify,
  exportVault,
  importVault,
  isBackupOverdue,
  isMediaCleanupPending,
  previewImport,
  recordBackupDelivered,
  recordMediaCleanupComplete,
  suggestBackupFilename,
  type BackupEnvelope,
  type BackupPreview,
  type BackupRow,
  type ExportOptions,
  type ImportMode,
  type ImportOptions,
  type ImportResult,
  type ImportSecret,
} from './backup';

export {
  MediaBackupCapabilityError,
  MediaMergeUnsupportedError,
  importPortableBackup,
  isPortableBackup,
  previewPortableImport,
  stagePortableBackupAndVerify,
  writePortableBackup,
  type PortableBackupPreview,
  type PortableBackupSink,
  type PortableImportResult,
  type StagedPortableBackup,
} from './media-backup';
