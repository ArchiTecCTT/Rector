const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const calculatorPath = path.join(root, "src", "calculator.ts");
const verifierPath = path.join(root, "src", "calculator.verify.ts");

if (!fs.existsSync(calculatorPath)) {
  throw new Error("fixture integrity verifier expected src/calculator.ts to exist");
}
if (!fs.existsSync(verifierPath)) {
  throw new Error("fixture integrity verifier expected src/calculator.verify.ts to exist");
}

const source = fs.readFileSync(calculatorPath, "utf8");
if (!/export\s+function\s+add\s*\(/.test(source)) {
  throw new Error("fixture integrity verifier expected calculator.ts to export add()");
}

console.log("fixture integrity verifier: PASS");
