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
export { install, uninstall, update, UnsupportedPlatformError } from "./install.ts";
export { macosPaths, LAUNCH_AGENT_LABEL } from "./paths.ts";
export { readStatus, describe as describeStatus, STATUS_TEXT } from "./status.ts";
export { pairDevice, PairingError } from "#src/pairing/pair-device";
export type { PairDeviceInput, PairDeviceResult, PairingFetch } from "#src/pairing/pair-device";
export { ackResult } from "#src/results/ack-result";
export type { AckResultInput, ResultAckFetch, ResultAckSleep } from "#src/results/ack-result";
