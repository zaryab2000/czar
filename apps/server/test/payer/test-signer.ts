import { loadConfig } from "@czar/config";
import type { Address, Hash32 } from "@czar/hashing";
import type { PaymentRef } from "@czar/schemas";
import {
  createSigner,
  memoryAudit,
  type Projection,
  type SignerBackend,
  type SignerNetwork,
  type TransactionPreparer,
} from "@czar/signer";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";

export interface TestSignerOptions {
  readonly projection?: Partial<Projection>;
  readonly network?: Partial<SignerNetwork>;
  readonly prepareTransaction?: TransactionPreparer;
}

export async function testSigner(options: TestSignerOptions = {}) {
  return (await testSignerWithDetails(options)).signer;
}

export async function testSignerWithDetails(options: TestSignerOptions = {}) {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const backend: SignerBackend = {
    name: "local-keystore",
    keyRefs: () => ["K3"],
    address: (keyRef) => (keyRef === "K3" ? account.address : undefined),
    signDigest: async (_keyRef, digest) => sign({ hash: digest, privateKey, to: "hex" }),
    signTransaction: async (_keyRef, transaction) => {
      if (options.prepareTransaction) return account.signTransaction(transaction);
      throw new Error("test signer does not send transactions");
    },
    createKey: async () => {
      throw new Error("test signer does not create keys");
    },
    destroyKey: async () => undefined,
  };
  const projectionFixture = {
    freezeState: async () => undefined,
    isVault: async () => true,
    reservation: async () => undefined,
    pullback: async () => undefined,
    blockNumber: async () => 0n,
    storedPlan: async () => undefined,
    envelope: async () => undefined,
    pocket: async () => undefined,
    pocketBalances: async () => {
      const balances = {
        gatewayApi: 0n,
        gatewayAvailable: 0n,
        gatewayApiObservedAt: null,
        gatewayWithdrawing: 0n,
        withdrawalBlock: 0n,
        currentBlock: 0n,
        usdc: 0n,
        native: 0n,
        pendingPullback: false,
        gatewayApiFresh: false,
      };
      return balances;
    },
    nanoSpent: async () => ({ step: 0n, pocket: 0n }),
    // SCR-180: this stand-in models no spend, indexed or pending.
    pendingNanoSpent: async () => ({ step: 0n, pocket: 0n }),
    pendingCalls: async () => 0,
    settledPayment: async (_vault: Address, _hash: PaymentRef) => true,
    autonomy: async () => undefined,
    job: async () => undefined,
    reportExists: async () => false,
    checksCommitExists: async () => false,
    latestEvidenceRoot: async () => `0x${"00".repeat(32)}` as Hash32,
    evidenceBatchExists: async () => false,
    nativeBalance: async () => 0n,
    slowWithdrawTrigger: async () => null,
    pocketSpendAfterObservation: async () => false,
    slowWithdrawAllowed: async () => false,
  };
  const projection: Projection = projectionFixture;
  const network: SignerNetwork = {
    chainId: 5042002,
    usdc: "0x3600000000000000000000000000000000000000",
    gatewayWallet: "0x0077777d7eba4688bdef3e311b846f25870a19b9",
    gatewayMinter: "0x0022222abe238cc2c7bb1f21003f0a260052475b",
    gatewayDomain: 26,
    jobEscrow: "0x0000000000000000000000000000000000000003",
    openEvidenceLog: "0x0000000000000000000000000000000000000004",
    nanoDomain: {
      name: "GatewayWalletBatched",
      version: "1",
      chainId: 5042002,
      verifyingContract: "0x0077777d7eba4688bdef3e311b846f25870a19b9",
    },
    merchantServices: [],
    ...options.network,
  };
  Object.assign(projection, options.projection);
  const config = loadConfig({ envFile: { "kms.maxSignaturesPerMin.K3": 100 } });
  const signer = createSigner({
    backend,
    projection,
    network,
    config,
    audit: memoryAudit(),
    callers: { "cz-15": ["K3"] },
    prepareTransaction:
      options.prepareTransaction ??
      (async () => {
        throw new Error("test signer does not prepare transactions");
      }),
  });
  return { signer, k3Address: account.address };
}
