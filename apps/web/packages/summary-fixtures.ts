import type { ManualReturn, MonthlyStatement } from "@czar/schemas";

export interface ShadowTotalsFixture {
  readonly minutesObserved: number;
  readonly estimatedSpendAtomic: string;
  readonly objectivesPriced: number;
}

export const monthlyStatementFixture: MonthlyStatement = {
  month: "2026-10",
  totalSpent: "2200000",
  totalSpentDisplay: "$2.20",
  totalMinutesSaved: 135,
  objectives: 3,
  receipts: 4,
  byCategory: [
    { category: "research", spent: "1600000", minutesSaved: 100 },
    { category: "data", spent: "600000", minutesSaved: 35 },
  ],
};

export const manualReturnsFixture: readonly ManualReturn[] = [
  {
    envelopeRef: "env_01J00000000000000000000000",
    vault: "0x0000000000000000000000000000000000000001",
    pocket: "0x0000000000000000000000000000000000000002",
    returnedAmount: "1234000",
    returnTx: `0x${"11".repeat(32)}`,
    state: "manual-return-required",
  },
  {
    envelopeRef: "env_01J00000000000000000000000",
    vault: "0x0000000000000000000000000000000000000001",
    pocket: "0x0000000000000000000000000000000000000003",
    returnedAmount: "2000000",
    returnTx: `0x${"22".repeat(32)}`,
    state: "recorded",
    recordedCredit: "1800000",
    recordedTx: `0x${"33".repeat(32)}`,
  },
  {
    envelopeRef: "env_01J00000000000000000000000",
    vault: "0x0000000000000000000000000000000000000001",
    pocket: "0x0000000000000000000000000000000000000004",
    returnedAmount: "500000",
    returnTx: `0x${"44".repeat(32)}`,
    state: "expired",
  },
];

export const shadowTotalsFixture: ShadowTotalsFixture = {
  minutesObserved: 135,
  estimatedSpendAtomic: "2200000",
  objectivesPriced: 3,
};
