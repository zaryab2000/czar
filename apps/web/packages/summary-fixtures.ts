import type { MonthlyStatement } from "@czar/schemas";

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

export const shadowTotalsFixture: ShadowTotalsFixture = {
  minutesObserved: 135,
  estimatedSpendAtomic: "2200000",
  objectivesPriced: 3,
};
