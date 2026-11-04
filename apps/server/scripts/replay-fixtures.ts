import { replayControlledFixtures } from "#src/social/controlled-fixtures";
import { controlledLocalContext } from "#src/social/controlled-local";

/** Replay controlled outcome events only on a validated loopback database. */
export async function main(): Promise<void> {
  const { pool } = await controlledLocalContext();
  try {
    const result = await replayControlledFixtures(pool);
    process.stdout.write(
      `Replayed ${result.outcomes} controlled outcomes and ${result.ratings} ratings.\n`,
    );
  } finally {
    await pool.end();
  }
}

await main();
