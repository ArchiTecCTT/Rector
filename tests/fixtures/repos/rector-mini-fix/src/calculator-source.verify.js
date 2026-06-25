const fs = require("node:fs");
const path = require("node:path");

const sourcePath = path.join(__dirname, "calculator.ts");
const source = fs.readFileSync(sourcePath, "utf8");

const hasAddImplementation = /return\s+a\s*\+\s*b\s*;/.test(source);
const hasSubtractImplementation = /return\s+a\s*-\s*b\s*;/.test(source);

if (!hasAddImplementation || hasSubtractImplementation) {
  throw new Error("calculator source verifier expected add(a, b) to return a + b");
}

console.log("calculator source verifier: PASS");
