# port-finder

Find a free TCP port — or bind a listening server on one — with **zero dependencies**. The package also includes a `port-finder` CLI for inspecting and checking ports from a terminal.

```js
const { findServer } = require('@atul_133/port-finder');

async function main() {
  // Binds 127.0.0.1 by default: reachable from this machine only.
  const { server, port } = await findServer({ start: 3000, end: 3100 });

  server.on('connection', (socket) => socket.end('Hello from port-finder\n'));

  console.log(`Listening on port ${port}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

## What it does

`port-finder` answers three related questions:

1. **Is this port free right now?** → `isPortFree()` returns a boolean.
2. **Which port is free right now?** → `findPort()` returns a port number.
3. **Give me a server already listening on a free port.** → `findServer()` returns a running `net.Server` and its real port.

It understands a single preferred port, an inclusive range, an explicit host and a list of excluded ports, and it reports *why* a search failed instead of pretending every failure means "busy".

## The problem it solves

Hardcoding `PORT = 3000` breaks as soon as two things run at once: a dev server and its tests, two worktrees, or two copies of an app. The usual fix — check whether a port is free, then bind it — has a gap between the check and the bind, and another process can take the port in that gap. The result is the familiar, intermittent:

```
Error: listen EADDRINUSE: address already in use :::3000
```

`port-finder` handles both halves properly:

- **`findPort()`** checks by actually binding, then closing, so the answer reflects what your process is allowed to do.
- **`findServer()`** skips checking entirely and binds first. If the port is taken it moves on; if it succeeds, the server that is listening is *the one you get back*. There is no gap for anyone to steal the port.

## Installation

```sh
npm install @atul_133/port-finder
```

## CLI

The package installs a `port-finder` executable. It uses the same zero-dependency
implementation as the JavaScript API.

### Install the CLI

Install it globally:

```sh
npm install --global @atul_133/port-finder
port-finder --help
```

Or install it in a project and run it with `npx`:

```sh
npm install --save-dev @atul_133/port-finder
npx port-finder --help
```

### List listening ports

```sh
port-finder
```

```text
PORT       PROCESS          PID
3000       node             1234
5000       ControlCenter    685
7000       ControlCenter    685

3 listening ports found.
```

Results are sorted by port and duplicate ports are removed. A missing process
name or PID is shown as `-`. With no listening ports, the command prints
`No listening TCP ports found.`

Listening-port discovery currently uses macOS `lsof`, so this command is
**macOS only**. On other platforms it exits with a clear error instead of
claiming there are no ports.

### Check a port or range

```sh
port-finder check 3000
```

```text
Port 3000 is available.
```

If something is already listening, the result is `Port 3000 is occupied.`

```sh
port-finder check 3000-4000
```

```text
Checking 1001 ports (3000-4000)...

Occupied (2): 3000, 3001
Available (999): 3002-4000
```

Consecutive ports are compacted into ranges. A check that cannot be completed
is reported as an error and is never counted as available. The command exits
`0` after a completed check whether the port is free or occupied, and `1` if a
probe fails.

### Find an available port

```sh
port-finder find
```

```text
Available port: 51234
```

The first form lets the operating system choose an ephemeral port.

```sh
port-finder find 3000-4000
```

```text
Available port in 3000-4000: 3002
```

A range limits the search to exactly those ports. Use a one-port range such as
`3000-3000` when you want only one candidate. `find` reports a port that was
free when checked; like `findPort()`, it does **not** reserve the port. If the
range is exhausted, the command exits `1` with an explanation.

### Options

| Option | Applies to | Meaning |
|---|---|---|
| `--host <host>` | `check`, `find` | Check or bind a specific host. Omitted means every local interface. |
| `-h`, `--help` | all | Show commands, examples, platform notes and exit codes. |

```sh
port-finder check 3000 --host 127.0.0.1
port-finder find 3000-4000 --host 127.0.0.1
```

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Command completed successfully. For `check`, this includes an occupied result. |
| `1` | Runtime or probe failure; for example the scanner is unsupported or a port check could not run. |
| `2` | Invalid command-line usage, such as a malformed port, range or option. |

### CLI versus JavaScript API

| | CLI | JavaScript API |
|---|---|---|
| Best for | Interactive terminal use, scripts and shell checks | Application code that needs a port number or listening server |
| Port discovery | `find` calls `findPort()` | `findPort()` / `findServer()` |
| Listing listeners | macOS-only `lsof` scan | Not exposed by the API |
| Reserves a port | No | Only `findServer()` binds and holds one |
| Installation | `port-finder` executable from this package | `require('@atul_133/port-finder')` |

The CLI is a separate entry point (`bin/port-finder.js`); it does not add or
change any of the package's 11 JavaScript exports.

### CLI platform compatibility

- Listening-port listing is verified on macOS only and requires `/usr/sbin/lsof`.
- `check` and `find` use Node.js TCP APIs. They have been verified on macOS;
  Linux and Windows remain unverified and are not claimed as supported.

## Requirements

- **Node.js 22 or newer.** The runtime uses only `node:net` and `node:os` APIs that are stable well below this, but 18 and 20 are end-of-life; 22 is the oldest maintained LTS line. (The test suite is verified on Node 22.23.5 and Node 24.14.0.)
- CommonJS project (or any project that can `require()` a CommonJS package); named ESM imports also work through Node's CommonJS interop (see [ESM usage](#esm-usage)).
- No runtime dependencies.

This package ships CommonJS only. There is no separate ESM build; ESM support comes from Node's CommonJS interop, not a second module format.

## Quick start

### Find a free port

```js
const { findPort } = require('@atul_133/port-finder');

async function main() {
  const port = await findPort();
  console.log(port); // e.g. 51234
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

### Prefer 3000, otherwise the next free port

```js
const { findPort } = require('@atul_133/port-finder');

async function main() {
  const port = await findPort(3000);
  console.log(port);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

### Search a bounded range

```js
const { findPort } = require('@atul_133/port-finder');

async function main() {
  const port = await findPort({ start: 3000, end: 3010, host: '127.0.0.1' });
  console.log(port);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

### ESM usage

The package is CommonJS and no ESM build is shipped. Node's interop still lets an
ESM file use named imports:

```js
import { findPort } from '@atul_133/port-finder';

const port = await findPort();
console.log(port);
```

That snippet must live in an ES module (`.mjs`, or a package with
`"type": "module"`), where top-level `await` is valid. The CommonJS examples in
this README use an `async function main()` for the same reason.

### Get a server that is already listening

```js
const http = require('node:http');
const { findServer } = require('@atul_133/port-finder');

async function main() {
  const app = http.createServer((req, res) => res.end('Hello from port-finder\n'));

  const { server, port } = await findServer({ start: 3000, end: 3100, host: '127.0.0.1' });

  // findServer() returns an already-listening TCP server. HTTP requests are
  // parsed by `app`, so each accepted connection is handed to it.
  server.on('connection', (socket) => app.emit('connection', socket));

  console.log(`Listening on http://127.0.0.1:${port}`);
  // Later, when shutting down:
  // server.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

> **Why the forwarding?** `findServer()` returns a `net.Server` (TCP), not an
> `http.Server`. A `net.Server` has no HTTP parser, so adding a `'request'`
> listener to it does nothing. Forwarding connections to a real `http.Server`
> keeps the race-free bind and gives you normal HTTP behaviour.

## API

All three functions are asynchronous and **always reject rather than throw synchronously**, so a single `try/catch` around an `await` is enough.

### `isPortFree(port, options?)`

> `Promise<boolean>`

Returns `true` when this process can bind `port` right now, `false` when something else already holds it.

```js
const { isPortFree } = require('@atul_133/port-finder');

async function main() {
  console.log(await isPortFree(3000));                        // true / false
  console.log(await isPortFree(3000, { host: '127.0.0.1' })); // only that address
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

- The port is checked by binding a real server and closing it immediately, so a `true` answer also means *you* are allowed to bind it.
- `false` means the port is genuinely occupied.
- **Every other problem rejects** — a permission error, an unusable host, resource exhaustion. A check that could not run is never reported as `true`, and a permission problem is never disguised as `false` (which would send you scanning thousands of ports for nothing).
- If every address probe is skipped without a single successful bind (for example, the OS rejects each local address), it rejects with `AvailabilityUnknownError` (`ERR_AVAILABILITY_UNKNOWN`). Availability is unknown, never assumed.
- `options` supports **`host` only**; unknown keys are rejected.

### `findPort(options?)`

> `Promise<number>`

Returns a port that was free at the moment it was checked. **It does not reserve the port** — see [Race conditions](#race-conditions).

| Call | Behaviour |
|---|---|
| `findPort()` | OS-assigned ephemeral port |
| `findPort({ host: '127.0.0.1' })` | OS-assigned ephemeral port on that host |
| `findPort(3000)` | 3000 if free, otherwise scan upward to 65535 |
| `findPort({ start: 3000 })` | same as above |
| `findPort({ start: 3000, end: 3010 })` | only 3000–3010; never scans past `end` |

If every candidate is occupied or excluded, it rejects with `NoAvailablePortError` (`ERR_NO_PORT_FOUND`) instead of quietly returning a port you did not ask for.

### `findServer(options?)`

> `Promise<{ server: net.Server, port: number }>`

Returns a server that is **already listening**, plus the port the operating system actually assigned (`port === server.address().port`).

```js
const { findServer } = require('@atul_133/port-finder');

async function main() {
  const { server, port } = await findServer({ start: 3000, end: 3010 });
  console.log(`Listening on ${port}`);
  server.close(); // the example is done; your app would keep it open
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

- **`host` defaults to `'127.0.0.1'`.** The returned server is reachable from this machine only. Pass `host: '0.0.0.0'` (IPv4) or `host: '::'` (IPv6) to listen on every interface. This differs from `findPort()` and `isPortFree()`, which default to checking every local interface.
- It is a plain **`net.Server`**, already listening, with **no `connection` handler attached**. Attach yours immediately after the promise resolves.
- For HTTP, the TCP server only accepts sockets; create an `http.Server` (or an Express app) and forward connections to it — see [Using `findServer()` with HTTP](#using-findserver-with-http). Closing the returned server stops new connections.
- **You own the server.** `findServer()` keeps no reference to it and will never close it. Call `server.close()` when your app shuts down.
- Supports the same calling styles as `findPort()`: no argument, a bare preferred port, or an options object.
- When the range is exhausted it rejects with `NoAvailablePortError`; permission and host problems reject with their own error classes.

### Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `start` | `number` | `null` | First port to try. `null` means "let the OS choose". A bare number passed as the whole argument is shorthand for `start`. |
| `end` | `number` | `65535` when `start` is set | Last port to try, inclusive. Requires `start`. |
| `host` | `string` | `null` for `isPortFree()`/`findPort()`; `'127.0.0.1'` for `findServer()` | Address to bind or probe. `null` means every local interface for the checking functions; `findServer()` deliberately defaults to loopback because it returns a listening surface. Pass `'0.0.0.0'` or `'::'` to listen everywhere. |
| `exclude` | `Array` \| `Set` \| iterable of ports | `[]` | Ports to skip. Excluding every port in a range is rejected, because the search could never succeed. |

Ports must be whole numbers from `1` to `65535`. Numeric strings such as `'3000'` are rejected on purpose, as are unknown option keys, so typos fail loudly.

**`host` defaults are intentionally different:** `isPortFree()` and `findPort()` only report availability, so an omitted host means "check every local interface". `findServer()` returns a server that is actually listening, so an omitted host means loopback (`127.0.0.1`). Opt into network exposure explicitly.

## `findPort()` vs `findServer()`

| | `findPort()` | `findServer()` |
|---|---|---|
| Returns | a number | a listening `net.Server` and its port |
| Reserves the port | **no** — the probe socket is closed first | **yes** — the returned server holds it |
| Can lose a race before you use it | yes, another process can take it | no, the port is already bound by you |
| You must call `listen()` | yes | no, it is already listening |
| Typical use | passing a port to another tool or your own `server.listen()` | starting this process's own server |

## Race conditions

A port check and a later bind are two separate operations. Between them, another process can take the port:

```
check port 3000   → free
                  ← another process binds 3000 here
bind port 3000    → EADDRINUSE 😞
```

No library can close that gap while returning only a number, because reserving a port means holding a socket — which would stop *your* server from binding it.

So:

- **`findPort()`** is a well-informed guess. If you use its number in your own `server.listen()`, still handle `EADDRINUSE` and retry with a new search.
- **`findServer()`** avoids the problem structurally: it binds before answering, treats `EADDRINUSE` as "try the next port", and hands you the exact server that won the bind. Nothing can take the port in between.

Every call keeps its own state, so concurrent `findPort()` and `findServer()` calls do not interfere with each other. Two `findServer()` calls for the *same single port* cannot both succeed: one gets the server, the other gets `ERR_NO_PORT_FOUND`.

## Error codes

Rejections caused by invalid input, port exhaustion, permissions or an unusable host are `PortFinderError` subclasses with a stable machine-readable `code`. Unexpected operating-system failures (for example `EMFILE`) are surfaced as the original Node.js error so they are never mistaken for a free port. Use `err.code` in conditions, or `instanceof` for the package's error classes:

```js
const { findPort, NoAvailablePortError } = require('@atul_133/port-finder');

async function main() {
  try {
    await findPort({ start: 3000, end: 3000 });
  } catch (error) {
    if (error instanceof NoAvailablePortError) {
      console.error('3000 is taken, try a different range');
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

| Code | Class | When it happens |
|---|---|---|
| `ERR_INVALID_PORT` | `InvalidPortError` | A port is not a whole number between 1 and 65535. |
| `ERR_INVALID_RANGE` | `InvalidRangeError` | `end` is lower than `start`. |
| `ERR_INVALID_OPTIONS` | `InvalidOptionsError` | Unknown option key, bad `host`, bad `exclude`, or `end` without `start`. |
| `ERR_PERMISSION_DENIED` | `PermissionDeniedError` | The OS refused the bind, usually a port below 1024 without administrator rights. |
| `ERR_HOST_UNAVAILABLE` | `HostUnavailableError` | The address is not on a local interface, or the hostname does not resolve. |
| `ERR_NO_PORT_FOUND` | `NoAvailablePortError` | Every candidate in the requested range is in use or excluded. |
| `ERR_AVAILABILITY_UNKNOWN` | `AvailabilityUnknownError` | No availability probe could be completed, so free/occupied could not be established. |
| `ERR_PORT_FINDER` | `PortFinderError` | Base class default; the specific subclasses above carry the real codes. |

Useful properties:

| Property | Present on | Value |
|---|---|---|
| `code` | every error | stable string from the table |
| `port` | `InvalidPortError`, `PermissionDeniedError`, `HostUnavailableError`, `AvailabilityUnknownError` | the port involved (on `InvalidPortError` only when the input was an integer) |
| `range` | `InvalidRangeError`, `NoAvailablePortError` | `{ start, end }`; on `NoAvailablePortError` only when a range was requested (absent for ephemeral searches) |
| `host` | `HostUnavailableError`, `PermissionDeniedError`, `NoAvailablePortError`, `AvailabilityUnknownError` | the requested host, when one was given (omitted for the all-interface default; `findServer()` reports its loopback default) |
| `excludeCount` | `NoAvailablePortError` | how many ports were excluded (property is absent when zero) |
| `option` | `InvalidOptionsError` | the offending option name |
| `value` | `InvalidPortError` | the raw input |
| `cause` | errors wrapping an OS error | the original Node.js error |

## Examples

Runnable versions live in [`examples/`](examples/):

- [`examples/basic.js`](examples/basic.js) — find an OS-assigned free port.
- [`examples/range.js`](examples/range.js) — find a free port inside a range.
- [`examples/http-server.js`](examples/http-server.js) — start an HTTP server with `findServer()`.

```sh
node examples/basic.js
node examples/range.js
node examples/http-server.js
```

### Using `findServer()` with HTTP

The server returned by `findServer()` accepts TCP connections. Wrap an
`http.Server` around it and forward each socket:

```js
const http = require('node:http');
const { findServer } = require('@atul_133/port-finder');

async function main() {
  const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Hello from Node.js\n');
  });

  const { server, port } = await findServer({ start: 3000, end: 3100, host: '127.0.0.1' });
  server.on('connection', (socket) => httpServer.emit('connection', socket));

  console.log(`Listening on http://127.0.0.1:${port}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

### Express

Requires Express to be installed in your project (`npm install express`).

```js
const http = require('node:http');
const express = require('express');
const { findServer } = require('@atul_133/port-finder');

async function main() {
  const app = express();
  app.get('/', (req, res) => res.send('Hello from Express'));

  const httpServer = http.createServer(app);
  const { server, port } = await findServer({ start: 3000, end: 3100, host: '127.0.0.1' });

  // Express does not listen itself here; it handles the connections that the
  // race-free TCP server accepts.
  server.on('connection', (socket) => httpServer.emit('connection', socket));

  console.log(`Express listening on http://127.0.0.1:${port}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

> Prefer `findPort()` with your own `http.Server.listen()` if the forwarding
> step feels heavier than it is worth — just handle `EADDRINUSE` and retry, as
> shown below.

### Using `findPort()` with your own server

Because `findPort()` cannot reserve the port, your `listen()` call can still lose
the race. Retry with a fresh search when that happens:

```js
const http = require('node:http');
const { findPort } = require('@atul_133/port-finder');

async function startServer(attempts = 5) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = await findPort({ start: 3000, end: 3100, host: '127.0.0.1' });
    const server = http.createServer((req, res) => res.end('Hello\n'));

    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once('error', onError);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', onError);
          resolve();
        });
      });
      return { server, port };
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      // Someone took the port between the check and the bind: search again.
    }
  }

  throw new Error('could not bind a port');
}

startServer()
  .then(({ port }) => console.log(`Listening on ${port}`))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
```

If that retry loop looks like work you would rather not own, use `findServer()`
instead — it removes the race by design.

## Platform notes and limitations

- **`findPort()` checks every local address by default.** A port is only reported free when the wildcards (`0.0.0.0`, `::`) *and* each concrete local address can be bound. This matters on macOS and other BSD systems, where a bind to `127.0.0.1` does not conflict with a listener on `0.0.0.0`.
- **An explicit `host` narrows that check.** `{ host: '127.0.0.1' }` asks only about `127.0.0.1`. On macOS/BSD a server listening on `0.0.0.0` will not be detected, because the OS genuinely lets you bind the loopback address anyway.
- **`findServer()` defaults to loopback.** It answers "can I bind `127.0.0.1`?", not "is this port unused everywhere?". If you explicitly ask for `0.0.0.0` or `::`, only that wildcard bind is attempted; on macOS/BSD such a bind can succeed while another process holds the same port on `127.0.0.1` only. The returned server is genuinely listening, but the port is not unused on every interface.
- **Ports below 1024 are privileged** on macOS and Linux and require root; `port-finder` reports `ERR_PERMISSION_DENIED` rather than silently skipping them.
- **Searching is sequential.** A very large, mostly occupied range performs one bind attempt per candidate, and there is no timeout. Keep ranges narrow.
- **Platform verification:** the test suite is verified on macOS with Node.js 22.23.5 and 24.14.0. It has not been run on Linux or Windows; the implementation uses portable Node.js APIs, but treat both platforms as unverified rather than supported-with-confidence.
- **IPv6** is supported where the OS provides it (`::` and `::1` are probed); IPv6-specific tests skip themselves when the host has no IPv6.

## License

[MIT](LICENSE) © Atul Panda
