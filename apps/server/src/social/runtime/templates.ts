import type { SocialExperienceCard, SocialLeadCard, SocialQuestionCard } from "@czar/schemas";

function ratingWord(rating: SocialExperienceCard["rating"]): string {
  return rating === "none" ? "none yet" : rating;
}

/** Render the specified one-line summary without exposing objective content. */
export function experienceSummary(handle: string, card: SocialExperienceCard): string {
  const supplier = `${card.serviceId} (${card.network})`;
  const rating = ratingWord(card.rating);
  switch (card.deliveryOutcome) {
    case "delivered":
      return (
        `${handle} bought ${card.taskClass} from ${supplier}. Delivered. ` +
        `Owner rating: ${rating}. ${card.callsPaid} paid call(s), ${card.amountBand} USDC. ` +
        "Checked by Czar's delivery checks; correctness is judged only by the owner's rating."
      );
    case "partial":
      return (
        `${handle} bought ${card.taskClass} from ${supplier}. ` +
        `${card.callsDelivered} of ${card.callsPaid} paid call(s) delivered. ` +
        `Owner rating: ${rating}. ${card.amountBand} USDC.`
      );
    case "not-delivered":
      return (
        `${handle} paid ${supplier} for ${card.taskClass} and got nothing usable. ` +
        `${card.callsPaid} paid call(s), ${card.amountBand} USDC.`
      );
    case "unknown":
      return (
        `${handle} bought ${card.taskClass} from ${supplier}. Delivery not checked. ` +
        `Owner rating: ${rating}. ${card.callsPaid} paid call(s), ${card.amountBand} USDC.`
      );
  }
}

/** Render the exact question sentence from its public card. */
export function questionSummary(handle: string, card: SocialQuestionCard): string {
  if (card.questionKind === "find-supplier") {
    const formatClause = card.outputFormat ? `, ${card.outputFormat}` : "";
    return (
      `${handle} needs a supplier for ${card.taskClass} ` +
      `(${card.capabilityTag}${formatClause}) on ${card.network}. ` +
      "Czar found none with evidence. Any representative with a paid experience or a lead?"
    );
  }
  return (
    `${handle} had paid calls to ${card.serviceId} (${card.network}) go badly for ` +
    `${card.taskClass}. Has any representative a separate experience with the same supplier and task?`
  );
}

/** Render a routed reply from the replier's own evidence. */
export function replySummary(
  handle: string,
  stance: "corroborates" | "contradicts" | "answers",
  card: SocialExperienceCard,
): string {
  const summary = `Delivered: ${card.deliveryOutcome}. Rating: ${ratingWord(card.rating)}.`;
  if (stance === "answers") return `${handle}: ${summary}`;
  return (
    `${handle}: separate experience, ${stance === "corroborates" ? "same" : "different"} ` +
    `outcome. ${summary}`
  );
}

/** Render a lead without implying its supplier has been verified. */
export function leadSummary(handle: string, card: SocialLeadCard): string {
  return (
    `${handle} suggests ${card.origin} for ${card.capabilityTag} on ${card.network}. ` +
    "Unverified until Czar probes it."
  );
}

/** Render the exact server probe outcome sentence. */
export function leadProbeSummary(
  origin: string,
  result: { network: string; rejectReason?: string },
): string {
  const probeResult = result.rejectReason
    ? `rejected (${result.rejectReason})`
    : `it answers with a valid x402 payment request on ${result.network}`;
  return `Czar probed ${origin}: ${probeResult}.`;
}

/** Render an incident opening from its public aggregate fields. */
export function incidentOpenedSummary(input: {
  distinctOwners: number;
  negativeUnits: number;
  serviceId: string;
  versionId: string | null;
  taskClass: string;
  windowDays: number;
}): string {
  const versionClause = input.versionId ? ` version ${input.versionId}` : "";
  return (
    `Incident opened: ${input.distinctOwners} owners reported ${input.negativeUnits} ` +
    `bad outcomes with ${input.serviceId}${versionClause} for ${input.taskClass} in the last ` +
    `${input.windowDays} days. Suppliers with an open incident need owner approval and rank ` +
    "below incident-free suppliers until it closes."
  );
}

/** Render an incident closing without exposing private evidence. */
export function incidentClosedSummary(closeReason: string, positiveUnits: number): string {
  return (
    `Incident closed (${closeReason}). ${positiveUnits} good-rated outcomes since the ` +
    "last bad one."
  );
}
