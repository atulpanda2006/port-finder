# port-finder

**Find available TCP ports, check occupied ports, and start servers without port conflicts.**

`port-finder` is a lightweight Node.js package that helps you work with TCP ports.

Have you ever encountered this error while starting your application?

```text
Error: listen EADDRINUSE: address already in use
```

This means another application is already using the port you wanted.

Instead of manually searching for another port, you can use `port-finder` to check available ports, find a free port, or directly start a server on an available port.

## Features

- Check whether a TCP port is available.
- Find an available port automatically.
- Find an available port within a specific range.
- Exclude ports from the search.
- Start a listening TCP server on an available port.
- List currently listening TCP ports, process names and PIDs through the CLI.
- Specify the host or network address to check.
- Handle port conflicts and other errors with dedicated error classes.
- Zero runtime dependencies.

## Requirements

- Node.js 22 or later.
- macOS, Linux or Windows for the JavaScript API.
- The CLI's listening-port listing currently uses macOS `lsof`. The CLI's `check` and `find` commands have only been verified on macOS.

## Installation

Install the package globally to use its command-line interface:

```bash
npm install -g @atul_133/port-finder
```

You can also run it without installing globally:

```bash
npx @atul_133/port-finder
```

To use it inside your Node.js project:

```bash
npm install @atul_133/port-finder
```

## Getting Started: Command Line

After installing the package globally, you can use the `port-finder` command directly in your terminal.

### 1. List listening ports

```bash
port-finder
```

Displays TCP ports currently being used by listening servers, along with their process names and PIDs.

Example output:

```text
PORT   PROCESS          PID
3000   node             1234
5000   python           5678

2 listening ports found.
```

### 2. Check a port

```bash
port-finder check 3000
```

Checks whether port `3000` is available or occupied.

Possible output:

```text
Port 3000 is available.
```

Or:

```text
Port 3000 is occupied.
```

### 3. Check a range of ports

```bash
port-finder check 3000-3010
```

Checks every port from `3000` to `3010`, including both endpoints.

Example output:

```text
Checking 11 ports (3000-3010)...

Occupied (2): 3001, 3005
Available (9): 3000, 3002-3004, 3006-3010
```

### 4. Find an available port

```bash
port-finder find
```

Asks the operating system to select an available port.

Example output:

```text
Available port: 52341
```

You can also search within a specific range:

```bash
port-finder find 3000-4000
```

### 5. Specify a host

```bash
port-finder check 3000 --host 127.0.0.1
```

Checks port `3000` on the specified address.

### 6. View help

```bash
port-finder --help
```

Displays available commands, options and examples.

## Using port-finder in JavaScript

You can also import `port-finder` into your Node.js application.

The package provides three main functions:

| Function | Purpose | Returns |
|---|---|---|
| `isPortFree()` | Checks whether a port is available | `boolean` |
| `findPort()` | Finds an available port | Port number |
| `findServer()` | Finds a port and starts a listening server | `{ server, port }` |

### 1. Check whether a port is available

Use `isPortFree()` to check whether a particular port can be used.

```javascript
const { isPortFree } = require('@atul_133/port-finder');

async function main() {
    const available = await isPortFree(3000);

    if (available) {
        console.log('Port 3000 is available.');
    } else {
        console.log('Port 3000 is occupied.');
    }
}

main().catch(console.error);
```

The function returns:

- `true` if the port can be bound.
- `false` if another process is already using it.
- An error if availability cannot be determined.

You can also specify a host:

```javascript
const available = await isPortFree(3000, {
    host: '127.0.0.1'
});
```

### 2. Find an available port

Use `findPort()` when you need an available port number.

```javascript
const { findPort } = require('@atul_133/port-finder');

async function main() {
    const port = await findPort();

    console.log(`Available port: ${port}`);
}

main().catch(console.error);
```

You can also provide a starting port:

```javascript
const port = await findPort(3000);
```

This searches from port `3000` upwards.

To restrict the search to a particular range:

```javascript
const port = await findPort({
    start: 3000,
    end: 3010
});
```

You can exclude specific ports:

```javascript
const port = await findPort({
    start: 3000,
    end: 3010,
    exclude: [3003, 3005]
});
```

You can also specify a host:

```javascript
const port = await findPort({
    start: 3000,
    end: 3010,
    host: '127.0.0.1'
});
```

### 3. Find and start a server

Use `findServer()` when you want to find an available port and immediately start a TCP server on it.

Unlike `findPort()`, this function actually binds the port and returns a server that is already listening.

```javascript
const { findServer } = require('@atul_133/port-finder');

async function main() {
    const { server, port } = await findServer();

    console.log(`Server is listening on port ${port}`);

    server.close();
}

main().catch(console.error);
```

You can also specify a preferred starting port:

```javascript
const { server, port } = await findServer(3000);
```

If port `3000` is occupied, it searches upwards for another available port.

To search within a specific range:

```javascript
const { server, port } = await findServer({
    start: 3000,
    end: 3010
});
```

You can exclude particular ports:

```javascript
const { server, port } = await findServer({
    start: 3000,
    end: 3010,
    exclude: [3003, 3005]
});
```

You can also specify the host:

```javascript
const { server, port } = await findServer({
    start: 3000,
    end: 3010,
    host: '0.0.0.0'
});
```

By default, `findServer()` listens on `127.0.0.1`, which makes the server accessible only from the local machine.

Use `0.0.0.0` or `::` when you explicitly want to listen on all interfaces.

Remember to call `server.close()` when you no longer need the server.

## Understanding the Three Functions

Although all three functions work with ports, they solve different problems.

| Function | What it does | Keeps the port occupied? |
|---|---|---|
| `isPortFree()` | Checks whether a port is available | No |
| `findPort()` | Finds an available port and returns its number | No |
| `findServer()` | Finds an available port and starts a listening server | Yes, while the server remains open |

**Which one should you use?**

- Use `isPortFree()` when you only want to check a particular port.
- Use `findPort()` when you need an available port number.
- Use `findServer()` when you want to start a listening TCP server without separately checking and binding the port.

## Error Handling

`port-finder` provides dedicated error classes for different failure situations.

The following errors are exported:

| Error class | Purpose |
|---|---|
| `PortFinderError` | Base error class |
| `InvalidPortError` | Invalid port number |
| `InvalidRangeError` | Invalid port range |
| `InvalidOptionsError` | Invalid options |
| `PermissionDeniedError` | Permission to bind was denied |
| `HostUnavailableError` | Specified host is unavailable |
| `NoAvailablePortError` | No available port was found |
| `AvailabilityUnknownError` | Port availability could not be determined |

You can import these classes and use `instanceof` to identify errors.

Example:

```javascript
const {
    findPort,
    NoAvailablePortError
} = require('@atul_133/port-finder');

async function main() {
    try {
        const port = await findPort({
            start: 3000,
            end: 3010
        });

        console.log(`Available port: ${port}`);
    } catch (error) {
        if (error instanceof NoAvailablePortError) {
            console.log('No available port found in this range.');
        } else {
            console.error(error.message);
        }
    }
}

main();
```

## Important Notes

### 1. Finding a port does not reserve it

`findPort()` checks whether a port is available and then closes its temporary socket.

Another application could occupy that port before your application starts listening.

If you need to find and bind a port without leaving a check-then-bind gap, use `findServer()`.

### 2. findServer() returns an already-listening server

The returned server is already listening when the promise resolves.

You are responsible for managing and closing it.

### 3. Host defaults are different

- `isPortFree()` and `findPort()` check every local interface by default.
- `findServer()` listens on `127.0.0.1` by default.

This difference is intentional.

## Examples

For more practical usage, check the [`examples/`](./examples) directory.

## Contributing

Contributions, bug reports and suggestions are welcome.

To contribute:

1. Fork this repository.
2. Create a new branch.
3. Make your changes.
4. Run the tests.
5. Submit a pull request.

Run the test suite using:

```bash
npm test
```

## License

This project is licensed under the [MIT License](./LICENSE).

## Author

**Atul Panda**

- GitHub: [@atulpanda2006](https://github.com/atulpanda2006)
- npm: [@atul_133/port-finder](https://www.npmjs.com/package/@atul_133/port-finder)

If you find this package useful, consider giving the repository a star.
