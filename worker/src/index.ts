// Session worker entrypoint: read newline-delimited JSON requests on stdin,
// write newline-delimited JSON responses on stdout. Anything human-readable goes
// to stderr — stdout is a machine channel and must stay parseable.

import { createInterface } from "node:readline";

import { grades } from "./handlers/grades.js";
import { login } from "./handlers/login.js";
import { schedule } from "./handlers/schedule.js";
import { status } from "./handlers/status.js";
import { WorkerError, send, type Request } from "./protocol.js";

async function dispatch(req: Request): Promise<unknown> {
  switch (req.op) {
    case "login":
      return login(req.id, req.params);
    case "status":
      return status(req.id, req.params);
    case "grades":
      return grades(req.id, req.params);
    case "schedule":
      return schedule(req.id, req.params);
    case "shutdown":
      process.exit(0);
  }
}

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin });

  // Requests are handled strictly in order. There is one browser profile and it
  // takes an exclusive lock, so concurrency would only ever be a bug.
  for await (const line of lines) {
    if (line.trim() === "") continue;

    let req: Request;
    try {
      req = JSON.parse(line) as Request;
    } catch {
      process.stderr.write("worker: ignoring unparseable line\n");
      continue;
    }

    try {
      send({ kind: "result", id: req.id, data: await dispatch(req) });
    } catch (err) {
      if (err instanceof WorkerError) {
        send({ kind: "error", id: req.id, code: err.code, message: err.message });
      } else {
        send({
          kind: "error",
          id: req.id,
          code: "internal",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`worker: fatal: ${String(err)}\n`);
  process.exit(1);
});
