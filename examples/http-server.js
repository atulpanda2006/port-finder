'use strict';

/**
 * Start an HTTP server on a free port with findServer().
 *
 * findServer() returns an already-listening *TCP* server. HTTP parsing lives in
 * an http.Server, so the example creates one and hands each accepted socket to
 * it. There is no server.listen() call for the HTTP server: it is fed by the
 * TCP listener that findServer() already bound.
 *
 *   node examples/http-server.js
 *   curl http://127.0.0.1:3000/
 */

const http = require('node:http');
const { findServer } = require('..');

const HOST = '127.0.0.1';

async function main() {
  const { server, port } = await findServer({ start: 3000, end: 3100, host: HOST });

  const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`Hello from port-finder on port ${port}\n`);
  });

  // Every connection the TCP server accepts is parsed by the HTTP server.
  server.on('connection', (socket) => httpServer.emit('connection', socket));

  console.log(`HTTP server listening on http://${HOST}:${port}`);
  console.log('Press Ctrl+C to stop.');

  const shutdown = () => {
    console.log('\nClosing server...');

    server.close(() => {
      console.log('Server closed.');
      process.exit(0);
    });

    // Close idle keep-alive sockets so close() can finish promptly.
    if (typeof httpServer.closeAllConnections === 'function') {
      httpServer.closeAllConnections();
    }

    // Do not hang forever if a socket refuses to go away.
    setTimeout(() => process.exit(0), 1000).unref();
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Could not start the server:', error.message);
  process.exitCode = 1;
});
