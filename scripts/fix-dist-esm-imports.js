#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : full.endsWith(".js") ? [full] : [];
  });
}

function hasKnownExtension(specifier) {
  return /\.(?:js|mjs|cjs|json|node)$/i.test(specifier);
}

function toPosix(specifier) {
  return specifier.replace(/\\/g, "/");
}

function resolveSpecifier(file, specifier) {
  if (!specifier.startsWith(".") || hasKnownExtension(specifier)) return specifier;

  const absolute = path.resolve(path.dirname(file), specifier);
  if (fs.existsSync(`${absolute}.js`)) return toPosix(`${specifier}.js`);
  if (fs.existsSync(path.join(absolute, "index.js"))) return toPosix(`${specifier}/index.js`);
  return specifier;
}

for (const file of walk(dist)) {
  const original = fs.readFileSync(file, "utf8");
  const rewritten = original
    .replace(/(\bfrom\s*["'])(\.[^"']+)(["'])/g, (_match, prefix, specifier, suffix) => {
      return `${prefix}${resolveSpecifier(file, specifier)}${suffix}`;
    })
    .replace(/(\bimport\s*\(\s*["'])(\.[^"']+)(["']\s*\))/g, (_match, prefix, specifier, suffix) => {
      return `${prefix}${resolveSpecifier(file, specifier)}${suffix}`;
    });

  if (rewritten !== original) fs.writeFileSync(file, rewritten);
}
