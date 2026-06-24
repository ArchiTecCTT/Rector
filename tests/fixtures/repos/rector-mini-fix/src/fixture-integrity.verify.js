import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const calculatorPath = join(root, "src", "calculator.ts");
const verifierPath = join(root, "src", "calculator.verify.ts");

if (!existsSync(calculatorPath)) {
  throw new Error("fixture integrity verifier expected src/calculator.ts to exist");
}
if (!existsSync(verifierPath)) {
  throw new Error("fixture integrity verifier expected src/calculator.verify.ts to exist");
}

const source = readFileSync(calculatorPath, "utf8");
if (!/export\s+function\s+add\s*\(/.test(source)) {
  throw new Error("fixture integrity verifier expected calculator.ts to export add()");
}

console.log("fixture integrity verifier: PASS");
