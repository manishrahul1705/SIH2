import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { ClamAvError, scanBuffer } from "../src/modules/documents/clamav.js";

const servers = new Set();

async function fakeClamAv(response) {
  const server = net.createServer((socket) => {
    let request = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      request = Buffer.concat([request, chunk]);
      if (request.length >= 4 && request.subarray(-4).equals(Buffer.alloc(4))) {
        server.lastRequest = request;
        socket.end(response);
      }
    });
  });
  servers.add(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { host: "127.0.0.1", port: server.address().port, server };
}

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise((resolve) => server.close(resolve))));
  servers.clear();
});

describe("ClamAV upload scanning", () => {
  it("reports an explicit unscanned status when no local scanner is configured", async () => {
    await expect(scanBuffer(Buffer.from("document"), { host: "" })).resolves.toEqual({ status: "UNSCANNED" });
  });

  it("streams a file to clamd and accepts only a clean response", async () => {
    const scanner = await fakeClamAv("stream: OK\0");
    const buffer = Buffer.from("%PDF-SAFE");

    await expect(scanBuffer(buffer, { ...scanner, timeoutMs: 1000 })).resolves.toEqual({ status: "CLEAN" });
    const request = scanner.server.lastRequest;
    expect(request.subarray(0, 10).toString("ascii")).toBe("zINSTREAM\0");
    expect(request.readUInt32BE(10)).toBe(buffer.length);
    expect(request.subarray(14, 14 + buffer.length)).toEqual(buffer);
    expect(request.subarray(-4)).toEqual(Buffer.alloc(4));
  });

  it("rejects infected uploads before they can be stored", async () => {
    const scanner = await fakeClamAv("stream: Eicar-Test-Signature FOUND\0");

    await expect(scanBuffer(Buffer.from("malware"), { ...scanner, timeoutMs: 1000 }))
      .rejects.toMatchObject({ code: "CLAMAV_INFECTED", status: 422 });
  });

  it("fails closed on malformed scanner responses that merely end in OK", async () => {
    const scanner = await fakeClamAv("unexpected NOT OK\0");

    await expect(scanBuffer(Buffer.from("document"), { ...scanner, timeoutMs: 1000 }))
      .rejects.toMatchObject({ code: "CLAMAV_INVALID_RESPONSE" });
  });

  it("fails closed when a configured scanner is unavailable", async () => {
    const reservation = net.createServer();
    await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));

    await expect(scanBuffer(Buffer.from("document"), { host: "127.0.0.1", port, timeoutMs: 1000 }))
      .rejects.toBeInstanceOf(ClamAvError);
    await expect(scanBuffer(Buffer.from("document"), { host: "127.0.0.1", port, timeoutMs: 1000 }))
      .rejects.toMatchObject({ code: "CLAMAV_UNAVAILABLE" });
  });
});
