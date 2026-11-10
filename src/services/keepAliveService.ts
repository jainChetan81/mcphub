import { SSEClientTransport, StreamableHTTPClientTransport } from '../clients/mcpSdkClient.js';
import { ServerInfo, ServerConfig } from '../types/index.js';
import { formatErrorForLogging } from '../utils/serialization.js';
import { logger } from '../utils/logger.js';

export interface KeepAliveOptions {
  enabled?: boolean;
  intervalMs?: number;
  reconnectServer?: (serverName: string) => Promise<void>;
  /** Returns the live ServerInfo for a name. Timers whose captured object is no longer live stop. */
  getServerInfo?: (serverName: string) => ServerInfo | undefined;
}

/**
 * Set up keep-alive ping for MCP client connections (SSE or Streamable HTTP).
 * Remote server health checks are opt-in because probes may count as upstream calls.
 */
export const setupClientKeepAlive = async (
  serverInfo: ServerInfo,
  serverConfig: ServerConfig,
  options: KeepAliveOptions = {},
): Promise<void> => {
  // Only set up keep-alive for SSE or Streamable HTTP client transports
  const isSSE = serverInfo.transport instanceof SSEClientTransport;
  const isStreamableHttp = serverInfo.transport instanceof StreamableHTTPClientTransport;
  if (!isSSE && !isStreamableHttp) {
    return;
  }

  // Repeated failed calls must not postpone an already scheduled recovery.
  if (
    serverInfo.enabled !== false &&
    serverInfo.status === 'disconnected' &&
    serverInfo.recovery?.nextAttemptAt !== undefined &&
    serverInfo.keepAliveIntervalId
  )
    return;

  if (serverInfo.keepAliveIntervalId) {
    clearInterval(serverInfo.keepAliveIntervalId);
    serverInfo.keepAliveIntervalId = undefined;
  }

  const canRetry = (): boolean =>
    serverInfo.enabled !== false && serverInfo.status === 'disconnected';

  if (serverInfo.enabled === false || serverInfo.status === 'oauth_required') {
    serverInfo.recovery = undefined;
    return;
  }

  if (serverInfo.status === 'disconnected' && options.reconnectServer) {
    const recovery = serverInfo.recovery ?? { attempts: 0 };
    serverInfo.recovery = recovery;
    // Equal jitter keeps retries spread out, bounded between 5 seconds and 5 minutes.
    const ceiling = Math.min(300000, 10000 * 2 ** Math.min(recovery.attempts, 5));
    const delay = Math.round(ceiling * (0.5 + Math.random() * 0.5));
    recovery.nextAttemptAt = Date.now() + delay;
    serverInfo.keepAliveIntervalId = setTimeout(async () => {
      serverInfo.keepAliveIntervalId = undefined;
      recovery.nextAttemptAt = undefined;
      if (!canRetry()) return;
      recovery.attempts += 1;
      recovery.lastAttemptAt = Date.now();
      try {
        await options.reconnectServer!(serverInfo.name);
      } catch (error) {
        if (canRetry() && serverInfo.recovery === recovery) {
          serverInfo.error = `Reconnect failed: ${formatErrorForLogging(error)}`;
          await setupClientKeepAlive(serverInfo, serverConfig, options);
        }
      }
    }, delay);
    return;
  }

  if (serverInfo.status === 'connected') serverInfo.recovery = undefined;
  const enabled = serverConfig.enableKeepAlive === true;
  if (!enabled) return;

  // Default interval: 60 seconds
  const interval = serverConfig.keepAliveInterval || 60000;
  let isChecking = false;

  // The live entry for this server name. Without a lookup, the captured object is the entry.
  const resolveLiveServerInfo = (): ServerInfo | undefined =>
    options.getServerInfo ? options.getServerInfo(serverInfo.name) : serverInfo;

  // Ownership is decided by timer id, not object identity. A shallow copy of a connected
  // server keeps the same keepAliveIntervalId, so its timer must keep running on that copy.
  let timerId: NodeJS.Timeout | undefined;
  const isOwnedByThisTimer = (candidate: ServerInfo | undefined): candidate is ServerInfo =>
    candidate !== undefined && timerId !== undefined && candidate.keepAliveIntervalId === timerId;

  const isHealthCheckCurrent = (
    candidate: ServerInfo | undefined,
    activeClient: NonNullable<ServerInfo['client']>,
  ): candidate is ServerInfo =>
    isOwnedByThisTimer(candidate) &&
    candidate.client === activeClient &&
    candidate.enabled !== false &&
    candidate.status !== 'connecting' &&
    candidate.status !== 'oauth_required';

  const shouldSkipCheck = (target: ServerInfo): boolean =>
    target.enabled === false || target.status === 'connecting' || target.status === 'oauth_required';

  const checkRemoteHealth = async (): Promise<void> => {
    const target = resolveLiveServerInfo();
    if (!isOwnedByThisTimer(target)) {
      // The live entry no longer holds this timer, so the timer is stale and stops.
      if (timerId) clearInterval(timerId);
      return;
    }
    const activeClient = target.client;
    if (shouldSkipCheck(target) || isChecking) {
      return;
    }

    if (target.status === 'disconnected' && options.reconnectServer) {
      await setupClientKeepAlive(target, serverConfig, options);
      return;
    }

    if (!activeClient) {
      return;
    }

    isChecking = true;

    try {
      // Modern HTTP has no ping or server-push channel. Discovery is supported
      // even by servers that expose no tools and discover() always performs a network request.
      if (activeClient.getProtocolEra?.() === 'modern') {
        await activeClient.discover({ ...(target.options || {}), timeout: 5000 });
      } else if (typeof activeClient.ping === 'function') {
        await activeClient.ping({ ...(target.options || {}), timeout: 5000 });
      } else {
        await activeClient.listTools({}, { ...(target.options || {}), timeout: 5000 });
      }

      const current = resolveLiveServerInfo();
      if (!isHealthCheckCurrent(current, activeClient)) {
        return;
      }

      if (current.status !== 'connected') {
        logger.log('Keep-alive ping restored server connection', {
          serverName: current.name,
        });
      }
      current.status = 'connected';
      current.error = null;
    } catch (error) {
      const current = resolveLiveServerInfo();
      if (!isHealthCheckCurrent(current, activeClient)) {
        return;
      }

      const message = formatErrorForLogging(error);
      const nextError = `Keep-alive failed: ${message}`;
      if (current.status !== 'disconnected' || current.error !== nextError) {
        logger.warn('Keep-alive ping failed', { serverName: current.name, error });
      }
      current.status = 'disconnected';
      current.error = nextError;
      await setupClientKeepAlive(serverInfo, serverConfig, options);
    } finally {
      isChecking = false;
    }
  };

  timerId = setInterval(async () => {
    await checkRemoteHealth();
  }, interval);
  serverInfo.keepAliveIntervalId = timerId;

  logger.log('Keep-alive enabled for server', {
    serverName: serverInfo.name,
    intervalSeconds: Math.round(interval / 1000),
  });
};

/**
 * Clear keep-alive timer for a server.
 */
export const clearClientKeepAlive = (serverInfo: ServerInfo): void => {
  serverInfo.recovery = undefined;
  if (serverInfo.keepAliveIntervalId) {
    clearInterval(serverInfo.keepAliveIntervalId as NodeJS.Timeout);
    serverInfo.keepAliveIntervalId = undefined;
    logger.log('Cleared keep-alive interval', { serverName: serverInfo.name });
  }
};
