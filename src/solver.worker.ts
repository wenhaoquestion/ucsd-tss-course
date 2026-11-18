import { solve, type SolveInput } from "./solver";
self.onmessage = (e: MessageEvent<SolveInput>) => {
  try {
    self.postMessage({ result: solve(e.data) });
  } catch {
    self.postMessage({ error: true });
  }
};
