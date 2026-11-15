#!/usr/bin/env node
// Installs the files hand control needs so the browser never fetches them from a
// CDN at play time: the MediaPipe WASM runtime (copied from node_modules) and the
// hand landmark model (downloaded once, verified by SHA-256). Existing valid
// files are reused and need no network connection.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasmSource = join(root, "node_modules/@mediapipe/tasks-vision/wasm");
const wasmTarget = join(root, "public/mediapipe/wasm");
const model = join(root, "public/models/hand_landmarker.task");
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const MODEL_SHA256 = "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1";

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

if (!existsSync(wasmSource)) {
  console.error("Hand control: run npm ci first (@mediapipe/tasks-vision missing).");
  process.exit(1);
}
mkdirSync(wasmTarget, { recursive: true });
cpSync(wasmSource, wasmTarget, { recursive: true });

if (existsSync(model) && sha256(readFileSync(model)) === MODEL_SHA256) {
  console.log("Hand control: model ready.");
} else {
  console.log("Hand control: downloading hand landmark model (7.8 MB)…");
  const response = await fetch(MODEL_URL);
  if (!response.ok) {
    console.error(`Hand control: download failed (${response.status}). The game still runs; hand control stays off.`);
    process.exit(0);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (sha256(buffer) !== MODEL_SHA256) {
    console.error("Hand control: model checksum mismatch; not installed.");
    process.exit(0);
  }
  mkdirSync(dirname(model), { recursive: true });
  writeFileSync(`${model}.part`, buffer);
  renameSync(`${model}.part`, model);
  console.log("Hand control: model installed.");
}
