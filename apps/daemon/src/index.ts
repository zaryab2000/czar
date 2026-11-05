export { Daemon } from "./daemon.ts";
export type { DaemonDeps, DaemonState, StatusSnapshot } from "./daemon.ts";
export { openMemoryDatabase, DatabaseLockedError, TABLES, SCHEMA_VERSION } from "./database.ts";
export { startHookServer, HOOK_PATH } from "./hook-server.ts";
export { startControlSocket, SOCKET_MODE } from "./control-socket.ts";
export {
  KEYCHAIN_ACCOUNTS,
  KEYCHAIN_SERVICE,
  KeychainUnavailableError,
  osKeychain,
} from "./keychain.ts";
export type { Keychain, KeychainAccount } from "./keychain.ts";
export { Launchctl, renderLaunchAgentPlist } from "./launchd.ts";
export { Loginctl, Systemctl, renderUserUnit, RESTART_INTERVAL_SECONDS } from "./systemd.ts";
export type { UserUnitInput } from "./systemd.ts";
export {
  install,
  uninstall,
  update,
  KeyringServiceMissingError,
  LINGER_REFUSED_LINE,
  UnsupportedPlatformError,
} from "./install.ts";
export type { InstallDeps, InstallFs, UninstallOptions } from "./install.ts";
export {
  macosPaths,
  linuxPaths,
  homeRelative,
  LAUNCH_AGENT_LABEL,
  SYSTEMD_UNIT_NAME,
} from "./paths.ts";
export type {
  DaemonPaths,
  DaemonPathsCommon,
  LinuxDaemonPaths,
  MacosDaemonPaths,
} from "./paths.ts";
export { readStatus, describe as describeStatus, STATUS_TEXT } from "./status.ts";
export type { CliStatus, ServiceManager } from "./status.ts";
export { pairDevice, PairingError } from "#src/pairing/pair-device";
export type { PairDeviceInput, PairDeviceResult, PairingFetch } from "#src/pairing/pair-device";
export { ackResult } from "#src/results/ack-result";
export type { AckResultInput, ResultAckFetch, ResultAckSleep } from "#src/results/ack-result";
