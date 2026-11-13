'use strict';

/**
 * Find a free port inside a bounded range.
 *
 *   node examples/range.js
 */

const { findPort } = require('..');

async function main() {
  const port = await findPort({ start: 3000, end: 3010, host: '127.0.0.1' });

  console.log(`Found a free port in 3000-3010: ${port}`);
}

main().catch((error) => {
  console.error('Could not find a port in 3000-3010:', error.message);
  process.exitCode = 1;
});
