import { openDemoContext } from "#src/social/demo-context";
import { runDemoReset } from "#src/social/demo-reset";
import { runDemoSeed } from "#src/social/demo-seed";

const { config, pool } = await openDemoContext(process.argv.slice(2));
try {
  const reset = await runDemoReset(pool, config);
  await runDemoSeed(pool, config);
  process.stdout.write(`${JSON.stringify({ ...reset, reseeded: true })}\n`);
} finally {
  await pool.end();
}
