// Seed data shared by the run 6 fixture and spec (SCR-150 §5). Amounts are Amount6 strings.
const ID_BODY = "01JRV6000000000000000000";

function id(prefix: string, suffix: string): string {
  return `${prefix}_${ID_BODY}${suffix}`;
}

function address(fill: string): string {
  return `0x${fill.repeat(40 / fill.length)}`;
}

function envelopeRef(vault: string, envelopeId: number): string {
  return `eip155:5042002:${vault}:${envelopeId}`;
}

function hash(byte: string): string {
  return `0x${byte.repeat(32)}`;
}

const ownerA = {
  userId: id("usr", "0A"),
  deviceId: id("dev", "0A"),
  objectiveId: id("obj", "0A"),
  planId: id("pln", "0A"),
  msca: address("a1"),
  vault: address("a2"),
  predictedVault: address("a2"),
  manualReturns: [
    {
      envelopeRef: envelopeRef(address("a2"), 1),
      pocket: address("a3"),
      returnedAmount: "1500000",
      returnTx: hash("a4"),
      state: "manual-return-required",
    },
    {
      envelopeRef: envelopeRef(address("a2"), 1),
      pocket: address("a5"),
      returnedAmount: "2500000",
      returnTx: hash("a6"),
      state: "manual-return-required",
    },
    {
      envelopeRef: envelopeRef(address("a2"), 1),
      pocket: address("a7"),
      returnedAmount: "700000",
      returnTx: hash("a8"),
      state: "recorded",
      recordedCredit: "700000",
      recordedTx: hash("a9"),
    },
  ],
};

const ownerB = {
  userId: id("usr", "0B"),
  deviceId: id("dev", "0B"),
  objectiveId: id("obj", "0B"),
  planId: id("pln", "0B"),
  msca: address("b1"),
  vault: address("b2"),
  envelopeRef: envelopeRef(address("b2"), 1),
  manualReturns: [
    {
      envelopeRef: envelopeRef(address("b2"), 1),
      pocket: address("b3"),
      returnedAmount: "1234000",
      returnTx: hash("b4"),
      state: "manual-return-required",
    },
    {
      envelopeRef: envelopeRef(address("b2"), 1),
      pocket: address("b5"),
      returnedAmount: "2000000",
      returnTx: hash("b6"),
      state: "recorded",
      recordedCredit: "1800000",
      recordedTx: hash("b7"),
    },
    {
      envelopeRef: envelopeRef(address("b2"), 1),
      pocket: address("b8"),
      returnedAmount: "500000",
      returnTx: hash("b9"),
      state: "expired",
    },
  ],
};

// Another user's rows, including one on owner B's envelope reference, must never be shown.
const otherUser = {
  userId: id("usr", "0C"),
  deviceId: id("dev", "0C"),
  objectiveId: id("obj", "0C"),
  planId: id("pln", "0C"),
  msca: address("c1"),
  vault: address("c2"),
  manualReturns: [
    {
      envelopeRef: envelopeRef(address("b2"), 1),
      pocket: address("c3"),
      returnedAmount: "9876000",
      returnTx: hash("c4"),
      state: "manual-return-required",
    },
    {
      envelopeRef: envelopeRef(address("c2"), 1),
      pocket: address("c5"),
      returnedAmount: "3300000",
      returnTx: hash("c6"),
      state: "manual-return-required",
    },
  ],
};

export const RUN6 = {
  network: "eip155:5042002",
  rpcUrl: "http://127.0.0.1:18549",
  anvilPort: 18549,
  serverPort: 4320,
  indexerPort: 42080,
  webPort: 3200,
  webOrigin: "http://localhost:3200",
  factoryAddress: "0xA624047E961D13bF49711e1383e7A3EBD3E25ef4",
  sessionMinutes: 60,
  zero: "0x0000000000000000000000000000000000000000",
  hash,
  ownerA,
  ownerB,
  otherUser,
  envelopeDetailB: {
    envelope: {
      schemaVersion: "1.1",
      envelopeRef: ownerB.envelopeRef,
      vault: ownerB.vault,
      envelopeId: 1,
      objectiveHash: hash("55"),
      planHash: hash("66"),
      payeeRoot: hash("77"),
      categoryId: hash("88"),
      cap: "4000000",
      maxStepAmount: "1000000",
      pocketCapBps: 5000,
      expiresAt: 1790000000,
      approver: "owner",
      approvalTx: hash("99"),
      spent: "0",
      reserved: "0",
      pocketOutstanding: "0",
      jobEscrowed: "0",
      state: "Open",
      lastEventBlock: 1,
    },
    reservations: [],
    pockets: [],
    jobs: [],
  },
};
