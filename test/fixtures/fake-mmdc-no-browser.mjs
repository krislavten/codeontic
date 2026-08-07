// Stands in for mmdc when puppeteer's browser was never downloaded — the exact
// error this repo's CI produced once a pnpm-store cache hit skipped the
// postinstall. Note the binary name: `chrome-headless-shell`, which an
// exact-match signature list for "Chrome"/"Chromium" misses entirely.
process.stderr.write(
  "Error: Could not find chrome-headless-shell (ver. 150.0.7871.24). " +
    "This can occur if either\n 1. you did not perform an installation before running the script " +
    "(e.g. `npx puppeteer browsers install chrome-headless-shell`) or\n 2. your cache path is " +
    "incorrectly configured.\n",
);
process.exit(1);
