const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const sourcePath = join(__dirname, "calculator.ts");
const source = readFileSync(sourcePath, "utf8");

const hasAddImplementation = /return\s+a\s*\+\s*b\s*;/.test(source);
const hasSubtractImplementation = /return\s+a\s*-\s*b\s*;/.test(source);

if (!hasAddImplementation || hasSubtractImplementation) {
  throw new Error("calculator source verifier expected add(a, b) to return a + b");
}

console.log("calculator source verifier: PASS");
