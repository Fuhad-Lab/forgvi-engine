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
const { session, extensionsResult } = await createAgentSession({
  model,
  thinkingLevel: "off",
  authStorage,
  modelRegistry,
  cwd,
  sessionManager: SessionManager.inMemory(),
  customTools: [createBashTool(cwd)],
});

const all = [];
session.subscribe((e) => {
  const a = e.assistantMessageEvent;
  if (a) all.push(`${e.type}:${a.type}${a.delta ? "…" + JSON.stringify(a.delta).slice(0, 40) : ""}`);
  else if (e.type !== "message_update") all.push(e.type + (e.toolName ? `(${e.toolName})` : ""));
});

await session.prompt("Use the bash tool to run: echo 'forgvi artifacts work' > proof.txt — then reply with just: PROOF WRITTEN");

console.log("--- EVENTS ---");
console.log(all.join("\n"));
console.log("--- MESSAGES ---");
for (const m of session.messages) {
  const parts = (m.content ?? []).map((c) => c.type === "text" ? `text=${JSON.stringify(c.text.slice(0, 80))}` : c.type === "toolcall" ? `toolcall=${c.name}(${JSON.stringify(c.arguments).slice(0, 60)})` : c.type === "toolresult" ? `toolresult=${JSON.stringify(String(c.output ?? c.content ?? "")).slice(0, 100)}` : c.type);
  console.log(`[${m.role}] ${parts.join(" | ")}`);
}
session.dispose();
