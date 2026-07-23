import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist");
const staticModules = ["facturas-copec", "calculo-combustible", "conciliacion-bancaria", "validador-precios-gasolina"];

await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
await fs.copyFile(path.join(root, "index.html"), path.join(output, "index.html"));

for (const moduleName of staticModules) {
  await fs.cp(path.join(root, moduleName), path.join(output, moduleName), { recursive: true });
}

console.log(`Sitio preparado en ${output}`);
