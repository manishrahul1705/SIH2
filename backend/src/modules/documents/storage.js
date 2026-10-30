import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env.js";

const root = path.resolve(process.cwd(), env.UPLOAD_DIR);

export const localStorage = Object.freeze({
  async save(buffer, originalName) {
    await fs.mkdir(root, { recursive: true });
    const id = crypto.randomUUID();
    const safeName = path.basename(originalName).replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "upload";
    const fileName = `${id}-${safeName}`;
    const absolutePath = path.join(root, fileName);
    await fs.writeFile(absolutePath, buffer, { flag: "wx", mode: 0o600 });
    return {
      fileName,
      absolutePath,
      filePath: path.relative(root, absolutePath),
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    };
  },
  resolve(filePath) {
    const target = path.resolve(root, filePath);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("Invalid storage path");
    return target;
  },
  async remove(filePath) {
    await fs.rm(localStorage.resolve(filePath), { force: true });
  },
  async quarantine(filePath) {
    const sourcePath = localStorage.resolve(filePath);
    const quarantineDirectory = path.join(root, "quarantine");
    await fs.mkdir(quarantineDirectory, { recursive: true, mode: 0o700 });
    const targetPath = path.join(quarantineDirectory, path.basename(sourcePath));
    await fs.rename(sourcePath, targetPath);
    return path.relative(root, targetPath);
  },
});
