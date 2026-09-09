/**
 * The notification socket.
 *
 * Attached to the same HTTP server the REST API already listens on, so there
 * is no second port to open, proxy or firewall. Upgrades arrive at one path
 * and are refused unless they carry a valid, unspent ticket.
 *
 * Traffic is one-way. The server sends notifications and pings; the client
 * sends nothing but pong frames. A client that could publish could address a
 * notice to somebody else, so the socket simply does not read messages.
 */

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { prisma } from '../config/database.js';
import { logger } from '../config/logger.js';
import { register, unregister, closeAll } from './registry.js';
import { consumeTicket, sweepConsumed } from './ticket.js';

/** Where the browser connects. Behind a proxy this is the path to forward. */
export const WS_PATH = '/ws';

/** Close code for anything wrong with the ticket. Deliberately undifferentiated. */
const CLOSE_UNAUTHORIZED = 4401;

/** Half a minute, so an idle proxy with a 60s timeout never sees silence. */
const HEARTBEAT_MS = 30_000;
/** Spent tickets are only worth remembering until they would expire anyway. */
const SWEEP_MS = 60_000;

type Timer = ReturnType<typeof setInterval>;
let heartbeat: Timer | null = null;
let sweeper: Timer | null = null;

/** Sockets that have answered the most recent ping. */
const alive = new WeakSet<WebSocket>();

function ticketFrom(req: IncomingMessage): string | null {
  // A relative URL needs a base to parse against; the value is discarded.
  const url = new URL(req.url ?? '', 'http://localhost');
  return url.searchParams.get('ticket');
}

/** Refuses the upgrade before any WebSocket exists. */
function reject(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/**
 * Binds the socket server to an existing HTTP server.
 *
 * `noServer` rather than letting ws own the upgrade: authentication has to
 * happen *before* a WebSocket is created, so a ticketless request is answered
 * with a plain HTTP 401 and never becomes a connection at all. That is also
 * what makes the deployment check meaningful — a 401 proves the request
 * reached this process, where a 404 or 502 proves it did not.
 */
export function attachWebSocketServer(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    // Anything not aimed at the notification path is left alone, in case
    // something else is ever attached to this server.
    const { pathname } = new URL(req.url ?? '', 'http://localhost');
    if (pathname !== WS_PATH) return;

    void (async () => {
      try {
        const ticket = ticketFrom(req);
        if (!ticket) return reject(socket, 401, 'Unauthorized');

        // Verifies signature, issuer, audience and expiry, and spends the jti.
        const userId = await consumeTicket(ticket);
        if (!userId) return reject(socket, 401, 'Unauthorized');

        // The same live check requireAuth performs: a token proves who you
        // were, the database says whether you still are.
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, isActive: true },
        });
        if (!user?.isActive) return reject(socket, 401, 'Unauthorized');

        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req, user.id);
        });
      } catch (error) {
        logger.error({ err: error }, 'WebSocket upgrade failed');
        reject(socket, 500, 'Internal Server Error');
      }
    })();
  });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, userId: string) => {
    register(userId, ws);
    alive.add(ws);

    ws.on('pong', () => alive.add(ws));
    // Inbound frames are ignored rather than parsed: there is no client→server
    // message this protocol accepts.
    ws.on('message', () => {});
    ws.on('close', () => unregister(userId, ws));
    ws.on('error', (error) => {
      logger.warn({ err: error, userId }, 'Notification socket error');
      unregister(userId, ws);
    });
  });

  // Terminates sockets that stopped answering — a dropped connection often
  // leaves no close frame behind, and those would otherwise linger forever.
  heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  sweeper = setInterval(() => sweepConsumed(), SWEEP_MS);
  sweeper.unref();

  return wss;
}

/** Closes every socket, for graceful shutdown and between tests. */
export function stopWebSocketServer(wss: WebSocketServer | null): Promise<void> {
  if (heartbeat) clearInterval(heartbeat);
  if (sweeper) clearInterval(sweeper);
  heartbeat = null;
  sweeper = null;
  closeAll();
  return new Promise((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
}
