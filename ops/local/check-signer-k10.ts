import { loadConfigFile, parameterEnvironment } from "@czar/config";
import { createSignerClient } from "@czar/signer";

const configPath =
  process.env["CZAR_LOCAL_CONFIG"] ?? new URL("../../env/local.toml", import.meta.url);
const config = await loadConfigFile(configPath, { env: parameterEnvironment(process.env) });
const signer = await createSignerClient({
  socketPath: String(config.get("signer.socketPath")),
  service: "merchants",
});

await signer.keyAddress("cz-20", "K10:czar-search");
