import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(__dirname, "calculator.ts");
const source = readFileSync(sourcePath, "utf8");

const hasAddImplementation = /return\s+a\s*\+\s*b\s*;/.test(source);
const hasSubtractImplementation = /return\s+a\s*-\s*b\s*;/.test(source);

if (!hasAddImplementation || hasSubtractImplementation) {
  throw new Error("calculator source verifier expected add(a, b) to return a + b");
}

console.log("calculator source verifier: PASS");
