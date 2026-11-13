# Port-Finder: Syllabus-Aligned Learning Guide

> **Project:** `@atul_133/port-finder@0.1.0`
>
> This guide is based on the actual implementation in `index.js`, `lib/`, and
> `examples/`. It is a learning resource, not a second specification. When code
> and prose disagree, the code is the source of truth.
>
> The package has **zero runtime dependencies** and is a **CommonJS** package
> requiring **Node.js 22 or newer**. The test suite has 102 tests and the
> project has been verified on macOS with Node 22.23.5 and Node 24.14.0.

## How to use this guide

1. Read the project map and Node.js section first.
2. Run the small examples yourself.
3. Attempt the interview questions before opening the answer key.
4. Treat the "Not applicable" notes as part of the lesson: good engineers do
   not force a known algorithm onto a problem that does not need it.

Legend for syllabus coverage:

- **Directly applicable** — the project really uses the idea.
- **Partially applicable** — related, but only as context.
- **Not applicable** — there is no honest connection in this codebase.

---

## 0. Project map

| File | Responsibility | Public? |
|---|---|---|
| `index.js` | Entry point. Re-exports three functions and eight error classes. | Yes |
| `lib/validate.js` | Validates and normalises every option shape. | No |
| `lib/check.js` | Binds a temporary TCP server to test availability; ephemeral ports; error classification. | No |
| `lib/find.js` | `findPort()` — scans a range or asks the OS for an ephemeral port. | Yes, through `index.js` |
| `lib/server.js` | `findServer()` — binds and returns a live `net.Server` on a free port. | Yes, through `index.js` |
| `lib/errors.js` | Error hierarchy with stable codes. | Error classes yes, helper no |
| `examples/basic.js` | Find a port and immediately check it. | Example |
| `examples/range.js` | Search a bounded range. | Example |
| `examples/http-server.js` | Serve HTTP on a `findServer()` listener. | Example |
| `test/*.test.js` | 102 unit/integration tests using `node --test`. | No |
| `package.json` | Package metadata, files whitelist, scripts, engine requirement. | Published metadata |

### The three public functions

```
isPortFree(port, options?) -> Promise<boolean>
findPort(options?)        -> Promise<number>
findServer(options?)      -> Promise<{ server: net.Server, port: number }>
```

The important difference:

- `isPortFree()` answers a **question**.
- `findPort()` returns a **number** that was free at the moment it was checked.
- `findServer()` returns a **bound server**, so the port cannot be stolen
  between the check and the caller's bind.

---

## 1. Node.js concepts

### 1.1 Node.js architecture and modules

**Simple idea.** Node.js runs JavaScript in Google's V8 engine. Some work (such
as parsing JavaScript) happens on the main thread; slow I/O such as file,
network, and DNS work is handed to the operating system or to libuv's thread
pool. JavaScript callbacks resume on the main thread when the result is ready.
That is why Node can handle many connections without one thread per connection.

**In this project.** `index.js` is a thin composition layer. It does not
implement port searching itself; it imports modules and exposes the public API:

```js
// index.js
const { isPortFree } = require('./lib/check');
const { findPort } = require('./lib/find');
const { findServer } = require('./lib/server');

module.exports = {
  isPortFree,
  findPort,
  findServer,
  // ...error classes
};
```

`lib/check.js` imports Node's built-in modules:

```js
const net = require('node:net');
const os = require('node:os');
```

The `node:` prefix makes it explicit that these are built-ins, not npm
packages. The project has no dependencies.

**Why it matters.** Modules let each file have one job. The public file is
small and stable; implementation files can change without changing the API.

**Try it.** Run `node -e "console.log(require('node:net') !== undefined)"`.
It prints `true`.

---

### 1.2 CommonJS exports and imports

**Simple idea.** CommonJS is Node's original module system. A file exports a
value with `module.exports`, and another file loads it with `require()`.
`require()` is synchronous and returns the exported value.

**In this project.** `lib/find.js` exports one function:

```js
// lib/find.js
module.exports = { findPort };
```

`index.js` imports it and re-exports it:

```js
const { findPort } = require('./lib/find');

module.exports = {
  findPort,
  // ...
};
```

A consumer uses:

```js
const { findPort } = require('@atul_133/port-finder');
```

`package.json` declares `"main": "index.js"` and `"type": "commonjs"`.

**Why it matters.** The package deliberately has one public entry point.
Consumers do not need to know that `findPort` lives in `lib/find.js`.

**Try it.**

```js
// save as try-cjs.js inside the project
const api = require('./index.js');
console.log(Object.keys(api).sort());
```

Expected output includes the three functions and eight error classes.

---

### 1.3 `node:net` and TCP sockets

**Simple idea.** TCP is a reliable, ordered byte stream between two endpoints.
A TCP server listens on an IP address and port. When a client connects, the
server receives a **socket** representing that connection. `node:net` exposes
TCP servers and sockets.

**In this project.** The core primitive is `tryBind()` in `lib/check.js`:

```js
const server = net.createServer();

server.once('error', onError);
server.once('listening', onListening);

server.listen({ port, host: host ?? undefined, exclusive: true });
```

The server has no `connection` handler in `tryBind()`. It is not there to serve
traffic; it is there to ask the operating system, "may I bind this port?"

On success, the project reads the address and closes the server immediately:

```js
const address = server.address();

server.close((closeError) => {
  server.removeListener('error', onError);
  if (closeError) reject(closeError);
  else resolve(address);
});
```

**Why bind instead of connect?** A connect test can be fooled by a firewall,
and it does not prove that *this process* is allowed to bind. Binding is the
same operation a real server performs, so it is the honest test.

**Try it.** The following is the smallest version of the idea:

```js
const net = require('node:net');

const server = net.createServer();
server.once('error', (err) => console.log('failed:', err.code));
server.once('listening', () => {
  console.log('bound:', server.address());
  server.close();
});
server.listen({ port: 0, host: '127.0.0.1' });
```

`port: 0` asks the operating system to choose an ephemeral port.

---

### 1.4 Asynchronous programming and Promises

**Simple idea.** An asynchronous function starts work and returns before the
work finishes. A `Promise` represents the eventual result: it is either
fulfilled with a value or rejected with an error. `async`/`await` lets us write
asynchronous code in a readable, sequential style.

**In this project.** `tryBind()` wraps the event-based `net` API in a Promise:

```js
function tryBind(port, host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    let settled = false;

    function onError(error) {
      if (settled) return;
      settled = true;
      server.removeListener('listening', onListening);
      reject(error);
    }

    function onListening() {
      if (settled) return;
      settled = true;
      server.removeListener('listening', onListening);
      // ...
    }

    // ...
    server.listen({ port, host: host ?? undefined, exclusive: true });
  });
}
```

`findPort()` then uses `await`:

```js
if (await isPortFree(port, checkOptions)) return port;
```

**Why it matters.** The caller gets one clear result or one rejection. Without
the `settled` guard, a late `error` after `listening` could try to reject an
already-resolved Promise.

**Try it.**

```js
async function demo() {
  const result = await Promise.resolve('ready');
  console.log(result);
}
demo();
```

---

### 1.5 Event loop and event handling

**Simple idea.** The event loop repeatedly picks up completed work and runs
its JavaScript callbacks. Network readiness, timers, and close events arrive as
events. Promises use a **microtask** queue, which runs before the next event
loop phase.

**In this project.** `tryBind()` listens for two events:

```js
server.once('error', onError);
server.once('listening', onListening);
```

`once()` is correct here because a bind attempt should settle exactly once.
The HTTP example also uses events:

```js
server.on('connection', (socket) => httpServer.emit('connection', socket));
```

Every TCP connection accepted by the port-finder server is forwarded to the
HTTP parser.

**Why it matters.** Understanding events explains why the code does not
"wait" in a loop. It registers interest, returns control to Node, and resumes
when the operating system reports success or failure.

**Try it.** Add temporary `console.log` calls inside `onListening` and
`onError`, then run `node examples/basic.js`.

---

### 1.6 Event listeners and their cleanup

**Simple idea.** A listener is a function attached to an event. If it is never
removed, it can keep objects alive, fire more than once, or crash the process
when a later `error` event has no handler.

**In this project.** `tryBind()` removes the temporary listeners:

```js
server.removeListener('listening', onListening); // on error
server.removeListener('error', onError);        // after close
```

The `error` listener deliberately stays attached until `close()` finishes.
Closing a server can itself emit an error; removing the listener too early
would turn that into an unhandled `'error'` event and crash Node.

The test suite checks this directly:

- `tryBind removes its listeners after a successful probe`
- `tryBind removes its listeners when the bind fails`
- `checking a port leaves no TCP servers behind`

**Why it matters.** A utility that leaks listeners or servers would be a poor
library: every call would consume resources.

**Try it.** Create a server, add a listener, then call
`server.listenerCount('listening')` before and after cleanup.

---

### 1.7 `listen()`, `close()` and `address()`

**Simple idea.**

- `server.listen()` starts the bind and begins accepting connections.
- `server.address()` reports what the operating system actually bound. It is
  only meaningful after `'listening'`.
- `server.close()` stops accepting new connections and releases the listening
  handle. Its callback runs after the handle is released.

**In this project.**

```js
server.listen({ port, host: host ?? undefined, exclusive: true });

// after 'listening'
const address = server.address();

server.close((closeError) => {
  if (closeError) reject(closeError);
  else resolve(address);
});
```

With `port: 0`, `address().port` is the only way to learn which port the OS
chose. That is how `findEphemeralPort()` works.

`exclusive: true` means Node should not share the handle with cluster workers;
a successful bind therefore really belongs to this process.

**Why it matters.** `close()` is asynchronous. Resolving the Promise before the
close callback would let the caller race against the still-open probe socket.

**Try it.** Bind port `0`, print `server.address()`, then close and bind the
same returned port again.

---

### 1.8 Server lifecycle

The probe lifecycle in `tryBind()`:

```
createServer()
    |
    v
listen({ port, host, exclusive: true })
    |
    +-- 'error' ----> remove 'listening' listener ---> reject
    |
    +-- 'listening' -> address() -> close()
                                      |
                                      +-- close error -> reject
                                      +-- success ----> resolve(address)
```

The `findServer()` lifecycle is different: it **keeps** the listening server
and returns it to the caller. The caller owns it and must close it.

**Why it matters.** "Listening" is a state, not a one-time function call. Clean
shutdown and correct error handling depend on knowing which state you are in.

---

### 1.9 Error handling and custom error classes

**Simple idea.** A custom error class gives callers a stable way to distinguish
failure types without parsing English messages.

**In this project.** All errors extend `PortFinderError`:

```js
class PortFinderError extends Error {
  constructor(message, { code = 'ERR_PORT_FINDER', port, range, value, cause } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    // optional fields only when supplied
    if (port !== undefined) this.port = port;
    // ...
    Error.captureStackTrace?.(this, this.constructor);
  }
}
```

The eight exported classes and codes are:

| Class | `code` | Meaning |
|---|---|---|
| `PortFinderError` | `ERR_PORT_FINDER` | Base class |
| `InvalidPortError` | `ERR_INVALID_PORT` | Not an integer 1–65535 |
| `InvalidRangeError` | `ERR_INVALID_RANGE` | `start > end` |
| `InvalidOptionsError` | `ERR_INVALID_OPTIONS` | Bad option shape, host, or exclude |
| `PermissionDeniedError` | `ERR_PERMISSION_DENIED` | OS refused the bind (often privileged port) |
| `NoAvailablePortError` | `ERR_NO_PORT_FOUND` | Search exhausted the allowed candidates |
| `HostUnavailableError` | `ERR_HOST_UNAVAILABLE` | Host is not local or does not resolve |
| `AvailabilityUnknownError` | `ERR_AVAILABILITY_UNKNOWN` | Every probe was skipped; no bind proved anything |

**Why it matters.** "Occupied" and "permission denied" look similar at the
socket level, but callers should react differently. The project classifies them
instead of turning everything into `false`.

**Try it.**

```js
const { findPort, InvalidPortError } = require('@atul_133/port-finder');

async function main() {
  try {
    await findPort('3000');
  } catch (error) {
    console.log(error instanceof InvalidPortError); // true
    console.log(error.code);                         // ERR_INVALID_PORT
  }
}

main();
```

Numeric strings are rejected on purpose; silently accepting `"3000"` would hide
type mistakes.

---

### 1.10 Resource management and concurrent operations

**Simple idea.** Every server, socket, and listener is a resource. A library
should release temporary resources before returning, and it should not share
mutable state between independent calls.

**In this project.**

- `tryBind()` always closes its probe server.
- `findServer()` closes servers it rejects (occupied or excluded) before trying
  the next port.
- Each `findPort()` call creates its own normalised options and `exclude` Set.
- Probes are sequential. On some systems binding IPv6 `::` also reserves the
  IPv4 wildcard; concurrent probes could collide with each other and report a
  fake `EADDRINUSE`.
- `findServer()` is race-free because it binds first and returns the bound
  server. `findPort()` is **not** a reservation: the probe closes before the
  number is returned.

**Why it matters.** Concurrency is not only "run things in parallel". It also
means avoiding interference between operations that should be independent.

**Try it.** Call `Promise.all([findPort(), findPort(), findPort()])` several
times. The results are usually distinct, but duplicates are legal because
nothing reserves the port. Compare with concurrent `findServer()` calls, which
must return distinct bound servers.

---

## 2. Application Programming: HTTP and Express

### 2.1 `net.Server` versus `http.Server`

**Simple idea.** TCP moves bytes. HTTP is a protocol layered on top of TCP that
interprets those bytes as requests and responses.

- `net.Server` accepts raw TCP connections and gives you sockets.
- `http.Server` accepts the same kind of connections but parses HTTP requests,
  builds `req` and `res` objects, and emits `'request'`.

In Node, `http.Server` builds on the TCP server machinery. The important
practical difference is that `net.Server` knows nothing about HTTP headers,
methods, status codes, or bodies.

**In this project.** `findServer()` returns a `net.Server`, not an
`http.Server`:

```js
// lib/server.js
const { server, port } = await findServer(...);
return { server, port };
```

That is deliberate: the package finds a port and binds a listener. It does not
choose your application protocol.

---

### 2.2 How an HTTP server starts listening

Normally you write:

```js
const http = require('node:http');
const server = http.createServer(handler);
server.listen(3000, '127.0.0.1');
```

`http.Server.listen()` creates/uses the underlying TCP listener and starts
accepting connections.

In `examples/http-server.js`, port-finder has already created and bound the TCP
listener. The HTTP server is never told to `listen()`:

```js
const { server, port } = await findServer({ start: 3000, end: 3100, host: HOST });

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`Hello from port-finder on port ${port}\n`);
});

server.on('connection', (socket) => httpServer.emit('connection', socket));
```

The `connection` event hands each accepted socket to the HTTP parser.

**Why this pattern?** It preserves the race-free guarantee: the TCP listener is
already bound, so no other process can take the port before HTTP starts.

---

### 2.3 How port-finder helps select an available port

`findServer()` tries to bind the requested port. If the operating system says
`EADDRINUSE`, it tries the next candidate. It never returns a port that it did
not successfully bind.

```js
// lib/server.js (simplified)
for (let port = start; port <= end; port += 1) {
  if (exclude.has(port)) continue;

  try {
    const server = await listenOnce(port, bindHost);
    return { server, port: server.address().port };
  } catch (error) {
    const failure = failureFor(error, port, bindHost);
    if (failure === null) continue; // occupied: try next
    throw failure;                  // permission/host/unknown: stop
  }
}
```

A bare number such as `findServer(3000)` means "prefer 3000, then scan upward
to 65535". A specified range never scans past `end`.

---

### 2.4 How HTTP requests reach a server

The path is:

```
client (curl / browser)
    |
    | TCP connection to 127.0.0.1:PORT
    v
port-finder's net.Server (already listening)
    |
    | 'connection' event -> socket
    v
http.Server parser
    |
    | 'request' event -> (req, res)
    v
your handler
    |
    | res.writeHead() / res.end()
    v
bytes written back over the socket
```

`req` contains method, URL, headers, and a readable body stream. `res` is a
writable stream with helpers such as `writeHead()` and `end()`.

---

### 2.5 How Express can use the port returned by `findServer()`

Express is not a dependency of this package, so the following is an
**illustrative integration**, not a runnable project example. Do not install
Express just to read this guide.

Express apps are request handler functions. You can build an `http.Server` from
the app and feed it the sockets accepted by port-finder's TCP server:

```js
// Illustrative only: requires express to be installed by the application.
const express = require('express');
const http = require('node:http');
const { findServer } = require('@atul_133/port-finder');

async function main() {
  const app = express();
  app.get('/', (req, res) => res.send('Hello from Express'));

  const httpServer = http.createServer(app);
  const { server, port } = await findServer({ start: 3000, end: 3100 });

  server.on('connection', (socket) => httpServer.emit('connection', socket));

  console.log(`Express listening on http://127.0.0.1:${port}`);
}

main().catch((error) => {
  console.error(error.code, error.message);
  process.exitCode = 1;
});
```

An alternative is `findPort()` plus `app.listen(port)`, which is shorter but
has a check-then-bind race: another process can take the port between the two
steps.

---

### 2.6 How to handle requests and responses

The project example handles every request the same way:

```js
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`Hello from port-finder on port ${port}\n`);
});
```

- `writeHead(200, headers)` sends the status line and headers.
- `end(body)` finishes the response; it can send a string or Buffer.
- For a JSON API, set `content-type: application/json` and pass
  `JSON.stringify(data)` to `end()`.
- A request body is read from `req` as a stream; do not assume it has already
  arrived when the handler starts.

---

### 2.7 How to gracefully shut down a server

"Graceful" means stop accepting new work, let existing work finish where
possible, and release the port. The example:

```js
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
```

`server.close()` stops the listener. It does not necessarily destroy sockets
that are already open, which is why the example closes idle connections and
adds a bounded fallback.

---

### 2.8 Why `findServer()` does not itself provide HTTP functionality

Because a port is not a protocol. The same listener could serve:

- HTTP,
- HTTPS/TLS,
- a custom TCP protocol,
- a database wire protocol,
- a game server.

Putting HTTP into `findServer()` would force every user to pay for HTTP
semantics and would make the package much harder to test. The separation is:

- **port-finder:** find and bind a TCP port safely;
- **HTTP/Express:** interpret the bytes that arrive on that port.

This is the single-responsibility principle in practice.

---

## 3. ADA and algorithmic analysis of `findPort()`

### 3.1 The actual algorithm

`findPort()` has two modes.

**Mode A — OS chooses an ephemeral port (`start === null`):**

```js
if (start === null) {
  return chooseEphemeralPort(host, exclude);
}
```

`chooseEphemeralPort()` calls `findEphemeralPort()`, which binds port `0`,
reads the assigned port, and closes the probe. If `exclude` is non-empty, it
retries up to `EPHEMERAL_ATTEMPTS = 10` times.

**Mode B — preferred port or bounded range:**

```js
const checkOptions = host === null ? undefined : { host };

for (let port = start; port <= end; port += 1) {
  if (exclude.has(port)) continue;

  if (await isPortFree(port, checkOptions)) return port;
}

throw new NoAvailablePortError({ start, end }, { host, excludeCount: exclude.size });
```

This is a **bounded linear search** over consecutive integer ports.

### 3.2 Searching strategy

The candidates are consecutive integers, not sorted arbitrary data. The
algorithm tests them in increasing order and returns the first free one.

Why not binary search? Because availability is **not monotonic**. Port 3000
being occupied says nothing about 3001. There is no ordering property that
would let us discard half the range.

### 3.3 Complexity model

Let:

- `N = end - start + 1` — number of candidate ports.
- `E = |exclude|` — number of excluded ports.
- `A` — number of addresses probed per candidate:
  - `A = 1` when the caller supplies an explicit `host`;
  - otherwise `A = 2 + L`, where `L` is the number of unique local addresses
    (both wildcard addresses are always included).

Each `isPortFree()` call may bind up to `A` temporary servers. The local work
per bind is constant; the real cost is the operating-system bind/close
operation.

| Case | Time | Explanation |
|---|---|---|
| **Best** | `O(A)` | The first candidate is not excluded and is free. With an explicit host, `A = 1`. |
| **Average** | `O(A / p)`, bounded by `O(N·A)` | If each candidate independently has probability `p` of being free, the expected number of candidates is about `1/p`. Real occupancy is correlated, so treat this as a model, not a guarantee. |
| **Worst** | `O(N·A)` | Every candidate is occupied or excluded; all are probed and then `NoAvailablePortError` is thrown. |

**Ephemeral mode:**

- No exclude: **one** bind attempt, `O(1)` probes.
- With exclude: at most **10** attempts, `O(1)` with a constant factor of 10.
- Failure after the attempt limit: `NoAvailablePortError`.

### 3.4 Space complexity

- `exclude` is stored as a `Set`: **O(E)**.
- `probeTargets()` builds an array of addresses: **O(A)** for the default host.
- The search itself uses one loop variable and one options object: **O(1)**
  auxiliary space beyond those structures.
- No recursion, no growing call stack, no memoisation table.

Overall auxiliary space: **O(E + A)**.

### 3.5 Termination conditions

The range loop terminates because `port` increases by exactly 1 and the
condition is `port <= end`. Ports are bounded by 65535, so the loop cannot run
forever.

Other termination paths:

1. A free port is found — return it.
2. Every candidate is excluded or occupied — throw `NoAvailablePortError`.
3. A permission, host, or unexpected resource error occurs — throw
   immediately rather than scanning thousands of ports for no reason.
4. Validation rejects an impossible request before scanning, e.g. a fully
   excluded range.
5. Ephemeral mode with excludes stops after 10 attempts.

### 3.6 Excluded ports

`exclude` is normalised to a `Set` in `lib/validate.js`. Membership testing is
expected **O(1)**. Excluded ports are skipped before any network operation, so
they save work.

If every port in a specified range is excluded, validation throws
`InvalidOptionsError` immediately instead of scanning and failing later. With
ephemeral selection, excluded ports can only be rejected after the OS chooses
them, hence the 10-attempt cap.

### 3.7 Concurrent execution

Each call has its own local state, so calls do not corrupt one another. They
can still observe the same free port, because checking does not reserve.

- Concurrent `findPort()` calls may return the same number.
- Concurrent `findServer()` calls for the same port produce exactly one
  winner; the others see `EADDRINUSE` and move on.

This is a **race condition** in the logical sense, not a data race in the
memory sense. JavaScript execution is single-threaded; the interleaving happens
between asynchronous bind/close operations and other processes.

### 3.8 Checking availability versus reserving a port

| | Checking (`isPortFree`, `findPort`) | Reserving (`findServer`) |
|---|---|---|
| Result | Boolean or number | A live, bound `net.Server` |
| Port held after return? | No | Yes |
| Race window? | Yes, between check and caller bind | No, bind already happened |
| Caller action | Use the number, then bind | Attach handlers / close when done |

`findPort()` is a well-informed guess, not a lock. The only way to guarantee
ownership is to keep the bound socket, which is exactly what `findServer()`
does.

### 3.9 Syllabus mapping — honest connections

| ADA topic | Applicability | Reason |
|---|---|---|
| **Linear search** | **Direct** | `findPort()` scans consecutive candidates. |
| **Bounded search / loop invariants** | **Direct** | The loop never passes `end`; excluded ports are skipped. |
| **Best/average/worst-case analysis** | **Direct** | Occupancy determines how many candidates are probed. |
| **Space complexity** | **Direct** | `exclude` Set and probe-target array. |
| **Concurrency / race conditions** | **Direct** | Check-then-bind versus bind-and-return. |
| **Dynamic programming** | **Not applicable** | There are no overlapping subproblems or optimal substructure to cache. |
| **Heap / priority queue** | **Not applicable** | Candidates are consecutive integers in a fixed order; a heap adds overhead without changing the scan. |
| **Graphs** | **Not applicable** | The code does not model vertices, edges, or traversal. "Network" here means sockets, not graph theory. |
| **Backtracking** | **Not applicable** | The search never explores a decision tree or undoes choices; it simply moves to the next port. |
| **SQL** | **Not applicable to the package** | There is no database. You could log results to a DB in an application, but that is external. |

**C++ connection.** The algorithm translates directly to a `for` loop and a
`std::set<int>` for excluded ports. The complexity is unchanged; the expensive
operation is the OS bind, not the integer comparison.

---

## 4. Software engineering concepts

### 4.1 Project architecture

The project uses a layered structure:

```
index.js            public facade
  |
  +-- lib/find.js       search policy
  +-- lib/server.js     bind-and-return policy
  +-- lib/check.js      low-level probe + error classification
  +-- lib/validate.js   input normalisation
  +-- lib/errors.js     error vocabulary
```

Dependencies point downward. `index.js` knows about implementation modules,
but `lib/find.js` does not know about `index.js`. There are no cycles.

### 4.2 Separation of responsibilities

| Concern | File | Why separate |
|---|---|---|
| Public API | `index.js` | One stable surface |
| Input rules | `lib/validate.js` | Invalid input is the most common failure |
| OS probing | `lib/check.js` | Hard, platform-specific logic |
| Search policy | `lib/find.js` | Range scanning and ephemeral retries |
| Server ownership | `lib/server.js` | Bind-first, race-free behavior |
| Error vocabulary | `lib/errors.js` | Stable codes and messages |

This makes each file easier to test and change. For example, changing the
error message does not require touching the search loop.

### 4.3 Input validation

`lib/validate.js` enforces:

- ports are integers from **1 to 65535**;
- `0` is not a user-requested port (it is an internal "OS chooses" signal);
- numeric strings such as `"3000"` are rejected;
- ranges must have `start <= end`;
- `end` is invalid without `start`;
- unknown option keys are rejected, so `{ prot: 3000 }` fails loudly;
- `host` must be a non-empty, non-padded string;
- `exclude` must be an iterable of valid ports;
- a fully excluded range is rejected before scanning.

Validation is synchronous and side-effect free. Host **resolution** is delayed
to the checking step, where network I/O belongs.

### 4.4 Error classification

`lib/check.js` maps OS error codes to four outcomes:

| Outcome | Codes | Action |
|---|---|---|
| `occupied` | `EADDRINUSE` | Port is busy; try the next one |
| `permission` | `EACCES`, `EPERM` | Stop; scanning will not help |
| `host` | `EADDRNOTAVAIL`, `EAFNOSUPPORT`, `EINVAL`, `ENOTFOUND`, `EAI_AGAIN`, `EAI_NODATA` | Stop if caller chose the host; skip if the OS supplied an address |
| `unexpected` | everything else, e.g. `EMFILE`, `ENOMEM` | Surface the error; never report "free" |

The guiding rule: **a check that could not run must never look like a free
port.**

### 4.5 Unit testing

The suite uses Node's built-in test runner:

```json
"scripts": { "test": "node --test" }
```

There are **102 tests** across five files:

| File | Tests | Focus |
|---|---:|---|
| `test/errors.test.js` | 7 | Error fields, codes, causes |
| `test/validate.test.js` | 37 | Every option shape and edge case |
| `test/check.test.js` | 25 | Binding, listeners, error classification |
| `test/find.test.js` | 14 | Range search, excludes, concurrency |
| `test/server.test.js` | 19 | Bind-first behavior, ownership, cleanup |

Unit tests target one layer, often by substituting `net.createServer` to force
specific OS errors.

### 4.6 Integration testing

Integration tests use real TCP servers and real binds. Examples from the suite:

- `isPortFree resolves false for a port that is already listening`
- `findServer binds an available port and returns a listening server`
- `the returned server keeps the port while the caller owns it`
- `concurrent calls for the same single port give exactly one server`

These verify that the layers work together, not just that each function returns
the expected mock value.

### 4.7 Regression testing

A regression test prevents a previously fixed bug from returning. Examples:

- `tryBind releases the port straight after a successful probe`
- `checking a port leaves no TCP servers behind`
- `an unknown networking error is reported, never mistaken for "occupied"`
- `getaddrinfo`/host failures are classified as host problems, not busy ports

Regression tests are valuable because the original bug is often subtle and
environment-dependent.

### 4.8 Edge cases covered

- port `1`, `65535`, `0`, negative, float, string, `NaN`;
- `start === end`;
- reversed range;
- a range fully covered by `exclude`;
- `end` without `start`;
- `exclude` as array, `Set`, generator, string, invalid entry;
- `host` empty, whitespace-padded, unresolved, non-local;
- privileged port permission failures;
- resource exhaustion (`EMFILE`);
- IPv6 and wildcard listeners;
- concurrent searches and concurrent binds for one port;
- listener and server cleanup after success and failure.

### 4.9 npm package structure

`package.json`:

```json
{
  "name": "@atul_133/port-finder",
  "version": "0.1.0",
  "type": "commonjs",
  "main": "index.js",
  "files": ["index.js", "lib", "examples"],
  "engines": { "node": ">=22" },
  "publishConfig": { "access": "public" },
  "scripts": {
    "test": "node --test",
    "example": "node examples/basic.js",
    "prepublishOnly": "npm test && npm pack --dry-run"
  }
}
```

The `files` whitelist keeps tests and development files out of the published
tarball. The package has **no dependencies**. `prepublishOnly` runs tests and a
dry-run pack before any publish.

### 4.10 Public API and exports

`index.js` exports exactly:

- functions: `isPortFree`, `findPort`, `findServer`;
- errors: `PortFinderError`, `InvalidPortError`, `InvalidRangeError`,
  `InvalidOptionsError`, `PermissionDeniedError`, `HostUnavailableError`,
  `NoAvailablePortError`, `AvailabilityUnknownError`.

Helpers such as `tryBind`, `normalizeOptions`, and `localAddresses` are
internal. Keeping them private allows the implementation to change without
breaking consumers.

### 4.11 CommonJS and ESM interoperability

The package is CommonJS-only (`"type": "commonjs"`, `main: "index.js"`). It has
no separate ESM build. Node can still import it from ESM:

```js
import { findPort, findServer } from '@atul_133/port-finder';
```

Named ESM imports work through Node's CommonJS interop (Node statically detects
the exported names). A default import receives the whole `module.exports`
object.

This is a compatibility feature, not a native ESM package. Consumers who need
tree-shaking or an `exports` map would need a future release; that is not part
of v0.1.0.

---

## 5. Practical exercises

### Exercise 1 — Find an available port

**Objective:** Ask the operating system for a free port and confirm it.

```js
// exercise-1.js
const { findPort, isPortFree } = require('@atul_133/port-finder');

async function main() {
  const port = await findPort();
  console.log('available:', port);
  console.log('free now:', await isPortFree(port));
}

main().catch((error) => {
  console.error(error.code, error.message);
  process.exitCode = 1;
});
```

**Expected output (port varies):**

```
available: 54321
free now: true
```

**Explanation:** `findPort()` with no arguments binds port `0`, reads the
OS-assigned port, closes the probe, and returns the number. The second check
re-binds it. Nothing else in this process took it, so it should still be free.

**Concept:** ephemeral ports, async/await, check versus reserve.

---

### Exercise 2 — Start an HTTP server on the returned port

**Objective:** Use `findServer()` to get a bound TCP listener and attach HTTP.

```js
// exercise-2.js
const http = require('node:http');
const { findServer } = require('@atul_133/port-finder');

async function main() {
  const { server, port } = await findServer({ start: 3000, end: 3100 });

  const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`Hello from port ${port}\n`);
  });

  server.on('connection', (socket) => httpServer.emit('connection', socket));

  console.log(`http://127.0.0.1:${port}`);
  console.log('Press Ctrl+C to stop.');
}

main().catch((error) => {
  console.error(error.code, error.message);
  process.exitCode = 1;
});
```

**Expected output (port depends on what is free):**

```
http://127.0.0.1:3000
Press Ctrl+C to stop.
```

**Explanation:** The `net.Server` is already listening. `http.createServer()`
creates the HTTP parser but does not listen. Each accepted socket is forwarded
to it with `emit('connection', socket)`.

**Concept:** `net.Server` versus `http.Server`, server lifecycle.

---

### Exercise 3 — Handle a client request

**Objective:** Send an HTTP request to the server from Exercise 2.

Start Exercise 2, then run:

```js
// exercise-3.js
const http = require('node:http');

http.get('http://127.0.0.1:3000/', (res) => {
  console.log('status:', res.statusCode);
  res.setEncoding('utf8');
  res.on('data', (chunk) => console.log('body:', chunk.trim()));
});
```

If Exercise 2 printed a different port, change the URL.

**Expected output:**

```
status: 200
body: Hello from port 3000
```

**Explanation:** `http.get()` opens a TCP connection, sends an HTTP request,
and reads the response as a stream. The server's `res.writeHead(200)` produces
the status, and `res.end(...)` produces the body.

**Concept:** request/response cycle, streams, event listeners.

---

### Exercise 4 — Handle an occupied port

**Objective:** Create an occupied port, verify it is busy, and make `findPort()`
skip it.

```js
// exercise-4.js
const { findServer, findPort, isPortFree } = require('@atul_133/port-finder');

async function main() {
  // Bind a real listener so the port is genuinely occupied.
  const { server: blocker, port: occupied } = await findServer({
    start: 4000,
    end: 4100,
  });

  console.log('occupied:', occupied);
  console.log('free?', await isPortFree(occupied, { host: '127.0.0.1' }));

  const next = await findPort({
    start: occupied,
    end: occupied + 20,
    host: '127.0.0.1',
  });
  console.log('next free:', next);
  console.log('different?', next !== occupied);

  await new Promise((resolve, reject) => {
    blocker.close((error) => (error ? reject(error) : resolve()));
  });
}

main().catch((error) => {
  console.error(error.code, error.message);
  process.exitCode = 1;
});
```

**Expected output (port varies):**

```
occupied: 4000
free? false
next free: 4001
different? true
```

**Explanation:** `findServer()` returns a live server, so the port stays bound.
`isPortFree()` sees `EADDRINUSE` and returns `false`. `findPort()` starts at the
occupied port, skips it, and returns the next free candidate inside the range.

**Concept:** occupied versus free, error classification, cleanup.

---

### Exercise 5 — Execute multiple concurrent port searches

**Objective:** Start several servers at the same time and confirm each gets a
distinct bound port.

```js
// exercise-5.js
const { findServer } = require('@atul_133/port-finder');

async function main() {
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      findServer({ start: 5000, end: 5100 })
    )
  );

  console.log(results.map(({ port }) => port).sort((a, b) => a - b));

  await Promise.all(
    results.map(({ server }) => new Promise((resolve) => server.close(resolve)))
  );

  console.log('all closed');
}

main().catch((error) => {
  console.error(error.code, error.message);
  process.exitCode = 1;
});
```

**Expected output (ports vary):**

```
[ 5000, 5001, 5002, 5003, 5004 ]
all closed
```

**Explanation:** The five calls run concurrently. Each `findServer()` attempts
to bind; losers get `EADDRINUSE` and move to the next port. Because each winner
returns a **bound** server, the ports are distinct.

For contrast, `Promise.all([findPort(), findPort()])` can return the same
number: it checks and closes, so it never reserves the port.

**Concept:** concurrency, race conditions, bind-first design.

---

## 6. Interview questions

### A. Port-finder project (20 questions)

1. What problem does port-finder solve?
2. Why does it bind a port instead of trying to connect to it?
3. Why does the default check probe both wildcard and concrete local addresses?
4. Why does `findServer()` not call `isPortFree()` internally?
5. What is the default host for `findServer()`, and why is it different from
   `findPort()`?
6. Explain the difference between `findPort()` and `findServer()`.
7. What happens when every port in a requested range is occupied?
8. How does the `exclude` option work for range searches and ephemeral searches?
9. What does port `0` mean internally, and why is it rejected as user input?
10. What does `findPort(3000)` mean? How is it different from
    `findPort({ start: 3000, end: 3000 })`?
11. Why does the package define eight error classes instead of returning `false`?
12. When is `AvailabilityUnknownError` thrown?
13. How does the code distinguish an occupied port from a permission failure?
14. Why are listeners removed in `tryBind()`, and why is the `'error'` listener
    kept until `close()` finishes?
15. What race exists between `findPort()` and a caller's `server.listen()`?
16. Who owns the server returned by `findServer()`?
17. Which names are public API, and which helpers are intentionally private?
18. Why are numeric strings such as `"3000"` rejected?
19. Why does the package have zero runtime dependencies?
20. What platform difference makes the wildcard-plus-local-address probing
    necessary on macOS/BSD?

### B. Node.js (10 questions)

21. What are the main parts of the Node.js runtime architecture?
22. How do CommonJS `require()` and `module.exports` work?
23. What does `node:net` provide, and what is a socket?
24. How does the event loop relate to Promises and timers?
25. Why is `'error'` a special event on an `EventEmitter`?
26. What is the difference between `on()` and `once()`?
27. What happens between `server.listen()` and the `'listening'` event?
28. Why is `server.close()` asynchronous, and what does its callback mean?
29. Why should a Promise-based wrapper guard against settling twice?
30. How can two asynchronous operations race even in single-threaded
    JavaScript?

### C. HTTP and Express (5 questions)

31. What is the difference between `net.Server` and `http.Server`?
32. How does an HTTP request travel from a TCP socket to a handler?
33. Why does `examples/http-server.js` never call `httpServer.listen()`?
34. How would you attach an Express app to the server returned by
    `findServer()`?
35. What steps make an HTTP server shutdown graceful?

### D. ADA and complexity (5 questions)

36. Why is `findPort()` a linear search rather than a binary search?
37. Give the best, average, and worst-case time complexity of `findPort()`.
38. What is the auxiliary space complexity, and what contributes to it?
39. What are the termination conditions of the range search?
40. Explain the difference between checking availability and reserving a port,
    including the race condition.

---

## 7. Answer key

> Try the questions first. These answers are intentionally concise; use the
> earlier sections for the full explanation.

### A. Port-finder project

1. **What problem does it solve?** It finds a TCP port that is free right now,
   or returns a live server bound to one, with predictable ranges and
   actionable errors instead of silently returning a busy port.

2. **Why bind instead of connect?** A connect test can be blocked by a firewall
   and does not prove the current process may bind. Binding performs the same
   operation a real server will perform.

3. **Why wildcard plus concrete addresses?** On macOS/BSD, overlapping binds do
   not conflict, so a loopback probe cannot see a server on `0.0.0.0` and vice
   versa. Probing both catches either case; Linux is stricter but the extra
   probes are harmless.

4. **Why not check then bind in `findServer()`?** Another process could take the
   port between the check and the bind. `findServer()` binds directly and
   treats `EADDRINUSE` as "try the next port", which is race-free.

5. **Default host difference?** `findServer()` defaults to `127.0.0.1` because
   it returns an actual listening surface and loopback is the safe default.
   `findPort()`/`isPortFree()` only answer availability and default to checking
   every local interface.

6. **`findPort` vs `findServer`.** `findPort()` returns a number after closing
   its probe; the port is not reserved. `findServer()` returns
   `{ server, port }` with the server already listening, so the caller owns the
   port.

7. **All ports occupied.** The range loop ends and throws
   `NoAvailablePortError` with the attempted range. It never scans past `end`.

8. **`exclude`.** For ranges, excluded ports are skipped before probing; a
   fully excluded range is rejected during validation. For ephemeral searches,
   the OS may choose an excluded port, so the code retries up to 10 times and
   then throws.

9. **Port 0.** Internally it means "let the OS choose an ephemeral port".
   `assertPort()` rejects it as user input because callers should use no
   argument/`start: null` for that behavior, and `0` is not a connectable port
   number in the usual sense.

10. **Bare number vs range.** `findPort(3000)` prefers 3000 and scans upward to
    65535. `findPort({ start: 3000, end: 3000 })` checks only 3000 and throws
    if it is unavailable.

11. **Why error classes?** Callers can branch on `instanceof` or stable
    `error.code` values. Returning `false` for permission, host, or resource
    failures would send callers scanning for no reason and hide the real fix.

12. **`AvailabilityUnknownError`.** It is thrown when every probe was skipped
    for address-specific reasons, so no bind actually proved the port free.
    Reporting `true` would be a false positive.

13. **Occupied vs permission.** `classifyProbeError()` maps `EADDRINUSE` to
    `occupied` and `EACCES`/`EPERM` to `permission`. Occupied means try the next
    port; permission means stop and report.

14. **Listener cleanup.** Temporary listeners must not leak or fire after the
    probe settles. The `'error'` listener stays until `close()` finishes because
    `close()` can emit an error; removing it early would cause an unhandled
    `'error'` crash.

15. **`findPort` race.** The probe socket is closed before the number is
    returned. Another process can bind the port before the caller calls
    `server.listen()`, producing `EADDRINUSE`. The caller should retry or use
    `findServer()`.

16. **Server ownership.** The caller owns the returned server. port-finder keeps
    no reference and will not close it; the caller attaches handlers and closes
    it when done.

17. **Public API.** `isPortFree`, `findPort`, `findServer`, and the eight error
    classes. Helpers such as `tryBind`, `normalizeOptions`, `localAddresses`,
    and `classifyProbeError` are internal.

18. **Why reject numeric strings?** Accepting `"3000"` hides type mistakes and
    creates surprising coercion behavior. The API requires a real number.

19. **Zero dependencies.** The task only needs Node built-ins (`net`, `os`), so
    avoiding dependencies reduces install size, supply-chain risk, and version
    conflicts.

20. **macOS/BSD difference.** BSD-derived systems allow overlapping binds by
    default (`SO_REUSEADDR` semantics), so `127.0.0.1` and `0.0.0.0` listeners
    can coexist. Linux rejects overlapping binds. Probing both directions is the
    portable way to notice an existing listener.

### B. Node.js

21. **Architecture.** V8 executes JavaScript; Node's built-in APIs provide
    modules such as `net` and `fs`; libuv and the OS handle asynchronous I/O,
    timers, and the event loop. JavaScript callbacks resume on the main thread.

22. **CommonJS.** `require()` synchronously loads a module and returns its
    `module.exports` value. Assigning `module.exports = { findPort }` exposes
    the object; destructuring imports individual properties.

23. **`node:net`.** It provides TCP servers, sockets, and low-level networking.
    A socket is one endpoint of a connection; a server listens and produces a
    socket for each accepted connection.

24. **Event loop and Promises.** Promise callbacks run as microtasks, which are
    drained before the next event-loop phase. Timers and I/O callbacks run in
    later phases. `await` pauses the async function, not the whole process.

25. **`'error'` is special.** If an `EventEmitter` emits `'error'` with no
    listener, Node throws it as an uncaught exception. That is why the probe
    keeps an error listener attached until close completes.

26. **`on()` vs `once()`.** `on()` runs every time the event fires; `once()`
    removes itself after the first call. A bind attempt should settle once, so
    `once()` is appropriate.

27. **`listen()` to `'listening'`.** `listen()` asks the OS to bind and starts
    the asynchronous operation. The `'listening'` event fires only after the
    bind succeeds; an `'error'` event fires on failure.

28. **`close()` callback.** Closing releases the listening handle
    asynchronously. The callback runs after the handle is released, which is
    why the probe waits for it before resolving.

29. **Settling twice.** A Promise can only be fulfilled or rejected once; later
    calls are ignored. The explicit `settled` flag prevents stale event
    handlers from doing extra work and makes the intended control flow clear.

30. **Async race in one thread.** JavaScript runs one piece at a time, but
    operations interleave at `await`/event boundaries. Two searches can both
    observe a port free before either caller binds it.

### C. HTTP and Express

31. **`net.Server` vs `http.Server`.** `net.Server` accepts raw TCP connections
    and exposes sockets. `http.Server` parses HTTP on those connections and
    emits `'request'` with `req`/`res`. HTTP is layered on TCP.

32. **Request path.** Client connects -> TCP server accepts socket -> HTTP
    parser reads bytes -> emits `'request'` -> handler writes response ->
    bytes go back over the socket.

33. **No `httpServer.listen()`.** The TCP listener is already bound by
    `findServer()`. Calling `httpServer.listen()` would try to bind a second
    listener. Instead, accepted sockets are forwarded with
    `httpServer.emit('connection', socket)`.

34. **Express integration.** Create `const httpServer =
    http.createServer(app)`, get `{ server, port }` from `findServer()`, and
    forward each `'connection'` socket to `httpServer`. Alternatively use
    `findPort()` and `app.listen(port)`, accepting the check-then-bind race.

35. **Graceful shutdown.** Stop accepting new connections with
    `server.close()`, close idle keep-alive connections, allow in-flight work to
    finish, add a bounded timeout fallback, and handle `SIGINT`/`SIGTERM`.

### D. ADA and complexity

36. **Why linear?** Availability is not monotonic: a busy port does not tell you
    anything about the next one. Binary search requires an ordered predicate
    that lets you discard half the candidates; this problem has none.

37. **Complexity.** Best `O(A)`, average approximately `O(A/p)` bounded by
    `O(N·A)`, worst `O(N·A)`, where `N` is the number of candidates and `A` is
    the number of addresses probed per candidate.

38. **Space.** `O(E + A)`: a Set of excluded ports and an array of probe
    targets. The loop itself uses `O(1)` auxiliary space; there is no recursion
    or memoisation.

39. **Termination.** The loop increments `port` until it exceeds `end`; a free
    port returns immediately, and exhaustion throws `NoAvailablePortError`.
    Validation can reject impossible ranges before the loop. Ephemeral mode with
    excludes stops after 10 attempts.

40. **Check vs reserve.** Checking binds and closes a probe, returning only
    information; the port is free for anyone afterward. Reserving keeps the
    bound socket and returns it, so ownership is guaranteed. The check-then-bind
    gap is the race condition.

---

## 8. Completion status

| Area | Status | Notes |
|---|---|---|
| Node.js concepts | **Completed** | Ten concepts with code, rationale, and examples. |
| HTTP and Express | **Completed with one illustrative snippet** | The project's `http-server.js` is real and runnable. Express is not a dependency, so the Express integration is illustrative and was not executed. |
| ADA analysis | **Completed** | Actual `findPort()` complexity, termination, excludes, concurrency, and race conditions. DP, heaps, graphs, and backtracking are explicitly marked not applicable. |
| Software engineering | **Completed** | Architecture, validation, errors, testing, packaging, API, CJS/ESM. |
| Practical exercises | **Completed (5 of 5)** | Code and expected output included. They were written from the verified API but not all re-run in this documentation session. |
| Interview preparation | **Completed (40 questions)** | 20 project, 10 Node.js, 5 HTTP/Express, 5 ADA/complexity, with a separate answer key. |
| Linux/Windows runtime verification | **Skipped — environment unavailable** | No usable Linux container/VM or Windows environment exists on this host; installing one was prohibited. This affects platform claims, not the guide's explanations. |
| Express execution | **Not completed — dependency unavailable** | Express is not installed and adding dependencies was prohibited; the integration remains illustrative. |
| SQL | **Not applicable** | No database is used or required by the package. |
| Dynamic programming, heaps, graphs, backtracking | **Not applicable** | No genuine algorithmic connection in `findPort()`; forcing them would teach the wrong lesson. |

## 9. Quick reference

| Task | Code |
|---|---|
| Check one port | `await isPortFree(3000)` |
| Find any free port | `await findPort()` |
| Prefer 3000, scan upward | `await findPort(3000)` |
| Bounded range | `await findPort({ start: 3000, end: 3010 })` |
| Exclude ports | `await findPort({ start: 3000, end: 3010, exclude: [3003] })` |
| Bind a server | `const { server, port } = await findServer({ start: 3000, end: 3010 })` |
| Close a server | `await new Promise((resolve) => server.close(resolve))` |

## 10. Source references

- `index.js` — public exports.
- `lib/errors.js` — error hierarchy and codes.
- `lib/validate.js` — input rules and normalisation.
- `lib/check.js` — `tryBind()`, `isPortFree()`, `findEphemeralPort()`, error
  classification.
- `lib/find.js` — `findPort()` and ephemeral exclusion retries.
- `lib/server.js` — `findServer()`, `listenOnce()`, default loopback host.
- `examples/basic.js`, `examples/range.js`, `examples/http-server.js` —
  runnable demonstrations.
- `test/*.test.js` — 102 tests covering unit, integration, and regression
  behavior.
- `README.md` — public API reference and platform notes.
- `PROGRESS.md` — project tracker and verified release status.
