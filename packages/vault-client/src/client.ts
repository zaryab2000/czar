// T-026: typed contract handles over the compiled interfaces (viem 2.57.x). Every call and its arguments are typed
// from the ABI, so a renamed function or a wrong argument fails at compile time.
import { getContract, type Address, type Client } from "viem";
import { czarVaultAbi, czarVaultFactoryAbi } from "./abi.ts";

export const getVault = (address: Address, client: Client | { public: Client; wallet?: Client }) =>
  getContract({ address, abi: czarVaultAbi, client });

export const getVaultFactory = (
  address: Address,
  client: Client | { public: Client; wallet?: Client },
) => getContract({ address, abi: czarVaultFactoryAbi, client });
