#!/usr/bin/env node
// Strip pre-fix Bellwether presence chatter from a Pi session file.
//
// Bellwether versions before 994c545 appended a `bellwether-intercom-signal`
// entry for every `capability` and `binding` presence announcement. This drops
// those entries, re-links children of dropped entries to the nearest surviving
// ancestor so the id/parentId tree stays intact, and verifies every remaining
// parent resolves before writing anything.
//
//   node scripts/strip-intercom-chatter.mjs <session.jsonl> [--apply] [--backup-dir DIR]
//
// Dry run by default. --apply copies the original to <file>.bak (or under DIR,
// mirroring the sessions tree) and then replaces the file atomically. Quit the
// Pi process that owns the session first: a live process keeps the old entries
// in memory and only a restart (then /herdr-resume and /until-resume) sheds them.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const ENTRY_TYPE = "bellwether-intercom-signal";
const DROP_KINDS = new Set(["capability", "binding"]);

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith("--"));
if (!file) {
  process.stderr.write("usage: strip-intercom-chatter.mjs <session.jsonl> [--apply] [--backup-dir DIR]\n");
  process.exit(2);
}
const apply = args.includes("--apply");
const backupDirIndex = args.indexOf("--backup-dir");
const backupDir = backupDirIndex >= 0 ? args[backupDirIndex + 1] : undefined;

const path = resolve(file);
const raw = readFileSync(path);
const lines = raw.toString("utf8").split("\n");
if (lines.at(-1) === "") lines.pop();

const parsed = lines.map((line) => {
  try {
    return { line, entry: JSON.parse(line) };
  } catch {
    return { line, entry: undefined };
  }
});

const dropped = new Map();
for (const { entry } of parsed) {
  if (!entry || entry.type !== "custom" || entry.customType !== ENTRY_TYPE || !entry.id) continue;
  const kind = entry.data && typeof entry.data === "object" ? entry.data.kind : undefined;
  if (DROP_KINDS.has(kind)) dropped.set(entry.id, entry.parentId ?? null);
}

const survivingParent = (parentId) => {
  let current = parentId;
  let hops = 0;
  while (current !== null && dropped.has(current)) {
    current = dropped.get(current);
    if (++hops > 1_000_000) throw new Error("parent cycle");
  }
  return current;
};

const kept = [];
const keptIds = new Set();
let relinked = 0;
let droppedBytes = 0;
for (const { line, entry } of parsed) {
  if (entry && dropped.has(entry.id)) {
    droppedBytes += Buffer.byteLength(line) + 1;
    continue;
  }
  let out = line;
  if (entry && entry.parentId && dropped.has(entry.parentId)) {
    entry.parentId = survivingParent(entry.parentId);
    out = JSON.stringify(entry);
    relinked += 1;
  }
  if (entry && entry.id) keptIds.add(entry.id);
  kept.push(out);
}

let unresolved = 0;
for (const line of kept) {
  try {
    const entry = JSON.parse(line);
    if (entry.parentId && !keptIds.has(entry.parentId)) unresolved += 1;
  } catch {
    // unparseable lines are preserved verbatim
  }
}

const report = {
  file: path,
  entriesBefore: parsed.length,
  dropped: dropped.size,
  droppedMegabytes: Number((droppedBytes / 1e6).toFixed(1)),
  relinked,
  entriesAfter: kept.length,
  unresolvedParentsAfterStrip: unresolved,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (unresolved > 0) {
  process.stderr.write("refusing: the tree would be broken\n");
  process.exit(1);
}
if (!apply) {
  process.stdout.write("dry run; pass --apply to write\n");
  process.exit(0);
}

let backup;
if (backupDir) {
  const sessionsRoot = join(homedir(), ".pi", "agent", "sessions");
  backup = join(resolve(backupDir), relative(sessionsRoot, path));
  mkdirSync(dirname(backup), { recursive: true });
} else {
  backup = `${path}.bak`;
}
if (existsSync(backup)) {
  process.stderr.write(`refusing: backup already exists at ${backup}\n`);
  process.exit(1);
}
copyFileSync(path, backup);
const temporary = `${path}.tmp`;
writeFileSync(temporary, `${kept.join("\n")}\n`);
renameSync(temporary, path);
process.stdout.write(`wrote ${path} (${(statSync(path).size / 1e6).toFixed(1)} MB), backup at ${backup}\n`);
