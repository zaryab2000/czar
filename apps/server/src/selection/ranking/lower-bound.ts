/** Conservative lower confidence bound for the share of good owner ratings. */
export function wilsonLower(good: number, total: number, z: number): number | null {
  if (!Number.isInteger(good) || !Number.isInteger(total) || good < 0 || total < good)
    throw new RangeError("Wilson counts must be non-negative integers with good <= total.");
  if (!Number.isFinite(z) || z < 0) throw new RangeError("Wilson z must be non-negative.");
  if (total === 0) return null;
  const proportion = good / total;
  const zSquared = z * z;
  const numerator =
    proportion +
    zSquared / (2 * total) -
    z * Math.sqrt((proportion * (1 - proportion)) / total + zSquared / (4 * total * total));
  return numerator / (1 + zSquared / total);
}
