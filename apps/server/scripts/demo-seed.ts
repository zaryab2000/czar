import { openDemoContext } from "#src/social/demo-context";
import { runDemoSeed } from "#src/social/demo-seed";

const { config, pool } = await openDemoContext(process.argv.slice(2));
try {
  await runDemoSeed(pool, config);
  process.stdout.write("Demo controlled audit history seeded and starting rank checked.\n");
} finally {
  await pool.end();
}
