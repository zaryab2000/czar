"use client";

import { useEffect, useRef, useState } from "react";
import {
  AppApiError,
  appApi,
  type AppRatingRequest,
  type AppResultCard,
  type AppResultSupplier,
} from "#src/app-api";
import { ratingThanks, resultRatingCopy } from "#src/result-cards";

interface ResultCardProps {
  readonly card: AppResultCard;
}

interface RatingAttempt {
  readonly body: AppRatingRequest;
  readonly key: string;
}

/** Show a delivered objective and the owner's rating controls for each supplier. */
export function ResultCard({ card }: ResultCardProps) {
  const [suppliers, setSuppliers] = useState(card.suppliers);
  const [editingStep, setEditingStep] = useState<number>();
  const [busyStep, setBusyStep] = useState<number>();
  const [notices, setNotices] = useState<Record<number, string>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const posting = useRef(false);
  const attempts = useRef(new Map<number, RatingAttempt>());

  useEffect(() => setSuppliers(card.suppliers), [card.suppliers]);

  async function rate(supplier: AppResultSupplier, value: "good" | "bad") {
    if (posting.current || (!supplier.canRate && !supplier.canCorrect)) return;
    const attempt = prepareRatingAttempt(attempts.current, card.objectiveId, supplier, value);
    if (typeof attempt === "string") {
      setErrors((previous) => ({
        ...previous,
        [supplier.stepIndex]: attempt,
      }));
      return;
    }
    posting.current = true;
    setBusyStep(supplier.stepIndex);
    setErrors((previous) => ({ ...previous, [supplier.stepIndex]: "" }));
    try {
      const accepted = await appApi.submitAppRating(attempt.body, attempt.key);
      attempts.current.delete(supplier.stepIndex);
      setSuppliers((previous) =>
        previous.map((item) =>
          item.stepIndex === supplier.stepIndex
            ? {
                ...item,
                effectiveRating: accepted.value,
                ratingId: accepted.ratingId,
                canRate: false,
                canCorrect: false,
              }
            : item,
        ),
      );
      setNotices((previous) => ({
        ...previous,
        [supplier.stepIndex]: ratingThanks(supplier.merchantLabel, accepted.value),
      }));
      setEditingStep(undefined);
      try {
        const refreshed = await appApi.listAllAppResults();
        const current = refreshed.items.find((item) => item.objectiveId === card.objectiveId);
        if (!current) throw new Error("The updated result card was not found.");
        setSuppliers(current.suppliers);
      } catch {
        setErrors((previous) => ({
          ...previous,
          [supplier.stepIndex]: "Rating saved, but controls could not refresh. Reload this page.",
        }));
      }
    } catch (cause) {
      if (cause instanceof AppApiError && cause.status < 500) {
        attempts.current.delete(supplier.stepIndex);
      }
      setErrors((previous) => ({
        ...previous,
        [supplier.stepIndex]:
          cause instanceof Error ? cause.message : "Czar could not save this rating.",
      }));
    } finally {
      posting.current = false;
      setBusyStep(undefined);
    }
  }

  return (
    <article className="panel result-card" aria-label={`Result ${card.objectiveId}`}>
      <h3>{card.kind}</h3>
      <p>
        {card.stepCount} steps{card.amountDisplay ? ` · ${card.amountDisplay}` : ""}
      </p>
      <time dateTime={card.deliveredAt}>{card.deliveredAt}</time>
      {suppliers.length === 0 && <p>No producing suppliers to rate.</p>}
      {suppliers.map((supplier) => (
        <SupplierRatingRow
          key={supplier.stepIndex}
          supplier={supplier}
          windowClosed={Date.now() > Date.parse(card.windowClosesAt)}
          editing={editingStep === supplier.stepIndex}
          busy={busyStep !== undefined}
          notice={notices[supplier.stepIndex]}
          error={errors[supplier.stepIndex]}
          onEdit={() => setEditingStep(supplier.stepIndex)}
          onCancel={() => setEditingStep(undefined)}
          onRate={(value) => rate(supplier, value)}
        />
      ))}
    </article>
  );
}

function prepareRatingAttempt(
  attempts: Map<number, RatingAttempt>,
  objectiveId: string,
  supplier: AppResultSupplier,
  value: "good" | "bad",
): RatingAttempt | string {
  if (supplier.canCorrect && !supplier.ratingId) {
    return "Czar could not identify the rating to change. Reload this page.";
  }
  const body: AppRatingRequest = {
    objectiveId,
    stepIndex: supplier.stepIndex,
    value,
    ...(supplier.canCorrect ? { supersedes: supplier.ratingId } : {}),
  };
  const previous = attempts.get(supplier.stepIndex);
  if (previous && (previous.body.value !== value || previous.body.supersedes !== body.supersedes)) {
    return "Retry the previous rating for this supplier before changing it.";
  }
  const attempt = previous ?? { body, key: crypto.randomUUID() };
  attempts.set(supplier.stepIndex, attempt);
  return attempt;
}

interface SupplierRatingRowProps {
  readonly supplier: AppResultSupplier;
  readonly windowClosed: boolean;
  readonly editing: boolean;
  readonly busy: boolean;
  readonly notice: string | undefined;
  readonly error: string | undefined;
  readonly onEdit: () => void;
  readonly onCancel: () => void;
  readonly onRate: (value: "good" | "bad") => void;
}

function SupplierRatingRow({
  supplier,
  windowClosed,
  editing,
  busy,
  notice,
  error,
  onEdit,
  onCancel,
  onRate,
}: SupplierRatingRowProps) {
  const canChoose = supplier.canRate || (supplier.canCorrect && !!supplier.ratingId && editing);
  const canChange = supplier.canCorrect && !!supplier.ratingId;
  return (
    <div className="result-supplier">
      <span>{supplier.merchantLabel}: </span>
      {supplier.effectiveRating !== "none" && (
        <strong>
          {
            resultRatingCopy[
              supplier.effectiveRating === "good" ? "results.rating.good" : "results.rating.bad"
            ]
          }
        </strong>
      )}
      {canChoose && (
        <span className="result-rating-actions">
          <button disabled={busy} onClick={() => onRate("good")} type="button">
            {resultRatingCopy["results.rating.good"]}
          </button>
          <span aria-hidden="true"> · </span>
          <button disabled={busy} onClick={() => onRate("bad")} type="button">
            {resultRatingCopy["results.rating.bad"]}
          </button>
        </span>
      )}
      {canChange && !editing && (
        <button onClick={onEdit} type="button">
          {resultRatingCopy["results.rating.change"]}
        </button>
      )}
      {editing && (
        <button onClick={onCancel} type="button">
          Cancel
        </button>
      )}
      {windowClosed && !supplier.canRate && !supplier.canCorrect && (
        <span>{resultRatingCopy["results.rating.closed"]}</span>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
