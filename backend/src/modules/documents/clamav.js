import net from "node:net";
import { env } from "../../config/env.js";

export class ClamAvError extends Error {
  constructor(message, code, status = 503) {
    super(message);
    this.name = "ClamAvError";
    this.code = code;
    this.status = status;
  }
}

export async function scanBuffer(buffer, {
  host = env.CLAMAV_HOST,
  port = env.CLAMAV_PORT,
  timeoutMs = env.CLAMAV_TIMEOUT_MS,
} = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new TypeError("A non-empty buffer is required for malware scanning");
  }
  if (!host) return { status: "UNSCANNED" };

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let response = Buffer.alloc(0);
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      finish(new ClamAvError("Malware scanner timed out", "CLAMAV_TIMEOUT"));
    }, timeoutMs);
    const clearTimerAndFinish = (error, result) => {
      clearTimeout(timer);
      finish(error, result);
    };

    socket.on("connect", () => {
      socket.write(Buffer.from("zINSTREAM\0", "ascii"));
      const length = Buffer.alloc(4);
      length.writeUInt32BE(buffer.length);
      socket.write(length);
      socket.write(buffer);
      socket.write(Buffer.alloc(4));
    });
    socket.on("data", (chunk) => {
      response = Buffer.concat([response, chunk]);
      if (response.length > 4096) {
        clearTimerAndFinish(new ClamAvError("Malware scanner returned an oversized response", "CLAMAV_INVALID_RESPONSE"));
        return;
      }
      if (!response.includes(0x0a) && !response.includes(0x00)) return;
      const message = response.toString("utf8").replace(/[\0\r\n]+$/, "");
      if (/^stream: OK$/.test(message)) {
        clearTimerAndFinish(null, { status: "CLEAN" });
      } else if (/^stream: .+ FOUND$/.test(message)) {
        clearTimerAndFinish(new ClamAvError("The uploaded file was identified as malware", "CLAMAV_INFECTED", 422));
      } else {
        clearTimerAndFinish(new ClamAvError("Malware scanner returned an invalid response", "CLAMAV_INVALID_RESPONSE"));
      }
    });
    socket.on("error", () => {
      clearTimerAndFinish(new ClamAvError("Malware scanner is unavailable", "CLAMAV_UNAVAILABLE"));
    });
  });
}
