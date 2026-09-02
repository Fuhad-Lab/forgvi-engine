// Tool probe: chief agent with bash+edit tools in a workspace — can it
// actually create files and run commands?
import {
  AuthStorage,
  createAgentSession,
  createBashTool,
  ModelRegistry,
  SessionManager,
} from "prime-agent";

const CFG = new URL("../.prime-agent/models.json", import.meta.url).pathname;
const authStorage = AuthStorage.create("/tmp/forgvi-probe-auth.json");
authStorage.setRuntimeApiKey("nvidia", process.env.NVIDIA_API_KEY);
const modelRegistry = ModelRegistry.create(authStorage, CFG);
const model = modelRegistry.find("nvidia", "nvidia/nemotron-3-super-120b-a12b");

const cwd = "/tmp/forgvi-probe-workspace";
const { session } = await createAgentSession({
  model,
  thinkingLevel: "off",
  authStorage,
  modelRegistry,
  cwd,
  sessionManager: SessionManager.inMemory(),
  customTools: [createBashTool(cwd)],
});

const toolEvents = [];
const unsub = session.subscribe((event) => {
  if (event.type === "tool_execution_start") toolEvents.push(`start:${event.toolName}`);
  if (event.type === "tool_execution_end") toolEvents.push(`end:${event.toolName}:err=${event.isError}`);
});

await session.prompt(
  "Use the bash tool to run: echo 'forgvi artifacts work' > proof.txt — then reply with just: PROOF WRITTEN",
);
unsub();

const last = [...session.messages].reverse().find((m) => m.role === "assistant");
const text = (last?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
console.log("tool events:", toolEvents.join(", ") || "NONE");
console.log("FINAL TEXT:", JSON.stringify(text));
import { readFileSync } from "node:fs";
try {
  console.log("proof.txt:", JSON.stringify(readFileSync(cwd + "/proof.txt", "utf8")));
} catch (e) {
  console.log("proof.txt: MISSING");
}
session.dispose();
