# Slyzera Multiplayer Deploy

This version is ready for a public Node.js host.

## Local test

```powershell
npm start
```

Open:

```text
http://localhost:8080
```

## Public multiplayer

To let people from anywhere play together, deploy this folder to a public Node.js server.

The host must support:

- Node.js 18+
- HTTP
- WebSocket upgrade requests
- `PORT` environment variable

Start command:

```text
npm start
```

The game must be opened through the public server URL, not through `file:///`.

Example:

```text
https://your-slyzera-server.com
```

The client automatically connects to:

```text
wss://your-slyzera-server.com/ws
```

or, for non-HTTPS local testing:

```text
ws://localhost:8080/ws
```

