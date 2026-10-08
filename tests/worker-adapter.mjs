import { parentPort } from "node:worker_threads";
import { register } from "tsx/esm/api";
register();
globalThis.self = globalThis;
globalThis.postMessage = (value) => parentPort.postMessage(value);
globalThis.close = () => process.exit(0);
const queue = [];
parentPort.on("message", (message) => {
  if (globalThis.onmessage) void globalThis.onmessage({ data: message });
  else queue.push(message);
});
await import("../src/document/document.worker.ts");
for (const message of queue) void globalThis.onmessage({ data: message });
parentPort.postMessage({ ready: true });
