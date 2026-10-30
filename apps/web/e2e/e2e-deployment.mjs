// The CzarVaultFactory on the Arc testnet fork the web E2E runs against (RPC 127.0.0.1:8549). The
// server fixture serves it through wallet-config and the indexer fixture reads its events; specs
// read it from wallet-config (SCR-157 §3).
export const E2E_VAULT_FACTORY = "0xA624047E961D13bF49711e1383e7A3EBD3E25ef4";
