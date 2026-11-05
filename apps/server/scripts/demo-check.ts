import { openDemoContext } from "#src/social/demo-context";
import { runDemoCheck } from "#src/social/demo-check";

const { config, pool } = await openDemoContext(process.argv.slice(2));
try {
  const checks = await runDemoCheck(pool, config);
  process.stdout.write(`${JSON.stringify(checks)}\n`);
  if (!checks.passed) process.exitCode = 1;
} finally {
  await pool.end();
}
