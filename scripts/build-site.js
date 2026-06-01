import fs from "node:fs";
import path from "node:path";

const __dirname = path.resolve();
const srcDir = path.join(__dirname, "src/public");
const destDir = path.join(__dirname, "dist/site");

console.log("=== Building Static Website for GitHub Pages ===");
console.log(`Source directory: ${srcDir}`);
console.log(`Destination directory: ${destDir}`);

// 1. Ensure target directory exists
if (!fs.existsSync(destDir)) {
  fs.mkdirSync(destDir, { recursive: true });
  console.log("Created target directory dist/site");
}

// 2. Define files to copy
const filesToCopy = [
  "index.html",
  "styles.css",
  "system.css",
  "app.js"
];

// 3. Copy files and verify
let success = true;
for (const file of filesToCopy) {
  const srcPath = path.join(srcDir, file);
  const destPath = path.join(destDir, file);

  if (fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, destPath);
    const size = fs.statSync(destPath).size;
    console.log(`✓ Copied ${file} (${size} bytes)`);
  } else {
    console.error(`✕ Error: Source file not found: ${srcPath}`);
    success = false;
  }
}

if (success) {
  console.log("=========================================");
  console.log("✓ SUCCESS: Static site successfully built in dist/site!");
  console.log("You can deploy the contents of dist/site directly to GitHub Pages.");
  console.log("=========================================");
  process.exit(0);
} else {
  console.error("=========================================");
  console.error("✕ FAILED: One or more files failed to copy.");
  console.log("=========================================");
  process.exit(1);
}
