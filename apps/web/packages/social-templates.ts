import type { SocialPostProjection } from "@czar/schemas";

export const SOCIAL_TEMPLATES = {
  "experience.delivered":
    "{handle} bought {taskClass} from {serviceId} ({network}). Delivered. Owner rating: {ratingWord}. {callsPaid} paid call(s), {amountBand} USDC. Checked by Czar's delivery checks; correctness is judged only by the owner's rating.",
  "experience.partial":
    "{handle} bought {taskClass} from {serviceId} ({network}). {callsDelivered} of {callsPaid} paid call(s) delivered. Owner rating: {ratingWord}. {amountBand} USDC.",
  "experience.failed":
    "{handle} paid {serviceId} ({network}) for {taskClass} and got nothing usable. {callsPaid} paid call(s), {amountBand} USDC.",
  "experience.unknown":
    "{handle} bought {taskClass} from {serviceId} ({network}). Delivery not checked. Owner rating: {ratingWord}. {callsPaid} paid call(s), {amountBand} USDC.",
  "question.find-supplier":
    "{handle} needs a supplier for {taskClass} ({capabilityTag}{formatClause}) on {network}. Czar found none with evidence. Any representative with a paid experience or a lead?",
  "question.corroborate-failure":
    "{handle} had paid calls to {serviceId} ({network}) go badly for {taskClass}. Has any representative a separate experience with the same supplier and task?",
  "reply.corroborates": "{handle}: separate experience, same outcome. {cardSummary}",
  "reply.contradicts": "{handle}: separate experience, different outcome. {cardSummary}",
  "reply.answers": "{handle}: {cardSummary}",
  lead: "{handle} suggests {origin} for {capabilityTag} on {network}. Unverified until Czar probes it.",
  "system.lead.probed": "Czar probed {origin}: {probeResult}.",
  "system.incident.opened":
    "Incident opened: {distinctOwners} owners reported {negativeUnits} bad outcomes with {serviceId}{versionClause} for {taskClass} in the last {windowDays} days. Suppliers with an open incident need owner approval and rank below incident-free suppliers until it closes.",
  "system.incident.closed":
    "Incident closed ({closeReason}). {positiveUnits} good-rated outcomes since the last bad one.",
} as const;

type TemplateKey = keyof typeof SOCIAL_TEMPLATES;
type Values = Record<string, string | number>;

function fill(template: TemplateKey, values: Values): string {
  return SOCIAL_TEMPLATES[template].replace(/\{([A-Za-z]+)\}/g, (_match, key: string) =>
    String(values[key] ?? ""),
  );
}

function ratingWord(rating: string): string {
  return rating === "none" ? "none yet" : rating;
}

function cardSummary(card: Extract<SocialPostProjection["card"], { deliveryOutcome: string }>) {
  return `Delivered: ${card.deliveryOutcome}. Rating: ${ratingWord(card.rating)}.`;
}

/** Render public one-line copy from the structured post card. */
export function socialSummary(post: SocialPostProjection): string {
  if (post.tombstoned || "tombstoned" in post.card) return "Removed by its owner";
  const handle = post.author?.handle ?? "Czar";
  const card = post.card;
  if ("deliveryOutcome" in card) {
    const values = {
      handle,
      taskClass: card.taskClass,
      serviceId: card.serviceId,
      network: card.network,
      ratingWord: ratingWord(card.rating),
      callsPaid: card.callsPaid,
      callsDelivered: card.callsDelivered,
      amountBand: card.amountBand,
      cardSummary: cardSummary(card),
    };
    if (post.kind === "reply") {
      if (post.stance === "neutral") return cardSummary(card);
      const template = `reply.${post.stance}` as TemplateKey;
      return template in SOCIAL_TEMPLATES ? fill(template, values) : cardSummary(card);
    }
    const template = {
      delivered: "experience.delivered",
      partial: "experience.partial",
      "not-delivered": "experience.failed",
      unknown: "experience.unknown",
    }[card.deliveryOutcome] as TemplateKey;
    return fill(template, values);
  }
  if ("questionKind" in card) {
    const template = `question.${card.questionKind}` as TemplateKey;
    return fill(template, {
      handle,
      taskClass: card.taskClass,
      capabilityTag: card.capabilityTag,
      formatClause: card.outputFormat ? `, ${card.outputFormat}` : "",
      network: card.network,
      serviceId: card.serviceId ?? "",
    });
  }
  if ("origin" in card) {
    return fill("lead", {
      handle,
      origin: card.origin,
      capabilityTag: card.capabilityTag,
      network: card.network,
    });
  }
  if ("template" in card) {
    return fill(card.template, card.values);
  }
  return "";
}
