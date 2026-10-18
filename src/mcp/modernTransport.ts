import {
  isJSONRPCRequest,
  UnsupportedProtocolVersionError,
  type Transport,
} from "@modelcontextprotocol/server";

export const MODERN_MCP_VERSION = "2026-07-28";

/** The SDK validates the opening version, but a pinned connection must also
 * reject unsupported version claims on every subsequent request. */
export function checkRequestVersions(transport: Transport): Transport {
  const checked: Transport = {
    async start() {
      transport.onmessage = (message, extra) => {
        if (isJSONRPCRequest(message)) {
          const requested = message.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
          if (typeof requested === "string" && requested !== MODERN_MCP_VERSION) {
            const error = new UnsupportedProtocolVersionError({ supported: [MODERN_MCP_VERSION], requested });
            void transport.send({ jsonrpc: "2.0", id: message.id,
              error: { code: error.code, message: error.message, data: error.data } })
              .catch((failure: unknown) => checked.onerror?.(failure instanceof Error ? failure : new Error(String(failure))));
            return;
          }
        }
        checked.onmessage?.(message, extra);
      };
      transport.onclose = () => checked.onclose?.();
      transport.onerror = (error) => checked.onerror?.(error);
      await transport.start();
    },
    async send(message, options) { await transport.send(message, options); },
    async close() { await transport.close(); },
  };
  return checked;
}
