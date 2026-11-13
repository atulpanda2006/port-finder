'use strict';

/**
 * Basic port discovery: let the operating system pick a free port.
 *
 *   node examples/basic.js
 */

const { findPort, isPortFree } = require('..');

async function main() {
  const port = await findPort();

  console.log(`An available port: ${port}`);

  // findPort() does not reserve the port, but nothing else in this process
  // took it, so it should still be free a moment later.
  console.log(`Free right now: ${await isPortFree(port)}`);
}

main().catch((error) => {
  console.error('Could not find a port:', error.message);
  process.exitCode = 1;
});
