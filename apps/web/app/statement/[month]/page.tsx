"use client";

import { useParams } from "next/navigation";
import { monthlyStatementFixture } from "#src/summary-fixtures";
import { formatUsd } from "@czar/web/money-format";

export default function StatementPage() {
  const params = useParams<{ month: string }>();
  const month = params.month;
  if (!/^\d{4}-\d{2}$/.test(month)) return <p role="alert">Choose a month in YYYY-MM format.</p>;
  const statement = { ...monthlyStatementFixture, month };
  return (
    <section className="page-stack">
      <p className="eyebrow">Sample statement preview</p>
      <h1 className="czar-title">Monthly statement</h1>
      <p>
        Czar saved you {formatHours(statement.totalMinutesSaved)} hours for{" "}
        {statement.totalSpentDisplay ?? formatUsd(statement.totalSpent)} in {statement.month}.
      </p>
      <h2>By category</h2>
      <ul className="rows">
        {statement.byCategory?.map((row) => (
          <li key={row.category}>
            <span>{row.category}</span>
            <span>{formatUsd(row.spent)}</span>
            <span>{row.minutesSaved} minutes</span>
          </li>
        ))}
      </ul>
      <p className="notice">Monthly statement data will connect when T-095 is available.</p>
    </section>
  );
}

function formatHours(minutes: number): string {
  return (minutes / 60)
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/(\.\d)0$/, "$1");
}
