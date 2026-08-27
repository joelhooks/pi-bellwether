import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const approved = [
  "LICENSE",
  "README.md",
  "extensions/pi-bellwether.ts",
  "package.json",
  "skills/pi-bellwether/SKILL.md",
  "src/herdr-client.ts",
  "src/intercom.ts",
  "src/ping-wait.ts",
  "src/watch.ts",
].sort();

const raw = execFileSync(
  "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  { encoding: "utf8" },
);
const report = JSON.parse(raw)[0];
if (!report || !Array.isArray(report.files)) {
  throw new Error("npm pack did not return one JSON file list");
}

const actual = report.files.map((entry) => entry.path).sort();
if (JSON.stringify(actual) !== JSON.stringify(approved)) {
  throw new Error(
    `package path set changed\nexpected: ${JSON.stringify(approved)}\nactual:   ${JSON.stringify(actual)}`,
  );
}

const forbidden = actual.filter(
  (path) =>
    path.startsWith(".brain/") ||
    path.startsWith(".agent-sources/") ||
    path.includes("/fixtures/") ||
    path.endsWith(".test.ts") ||
    path.endsWith("test-support.ts"),
);
if (forbidden.length > 0) {
  throw new Error(`forbidden package paths: ${forbidden.join(", ")}`);
}

const privateFiles = actual.filter((path) => {
  const text = readFileSync(path, "utf8");
  return /privacy\s*:\s*["']?private\b/i.test(text);
});
if (privateFiles.length > 0) {
  throw new Error(`private files in package: ${privateFiles.join(", ")}`);
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    entryCount: actual.length,
    packageSize: report.size,
    unpackedSize: report.unpackedSize,
    files: actual,
  })}\n`,
);
