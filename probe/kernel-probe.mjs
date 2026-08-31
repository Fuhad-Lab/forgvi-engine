// Live probe: drive the prime-agent kernel against the real NVIDIA NIM
// provider via models.json. Verifies: ModelRegistry.find, auth from env,
// createAgentSession, streaming events, final text extraction.
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "prime-agent";

const CFG = new URL("../.prime-agent/models.json", import.meta.url).pathname;

const authStorage = AuthStorage.create("/tmp/forgvi-probe-auth.json");
authStorage.setRuntimeApiKey("nvidia", process.env.NVIDIA_API_KEY);
const modelRegistry = ModelRegistry.create(authStorage, CFG);
const model = modelRegistry.find("nvidia", "nvidia/nemotron-3-super-120b-a12b");
console.log("model resolved:", model.provider + "/" + model.id, "| api:", model.api, "| baseUrl:", model.baseUrl ?? "(api default)");

const { session, modelFallbackMessage } = await createAgentSession({
  model,
  thinkingLevel: "off",
  authStorage,
  modelRegistry,
  cwd: "/tmp/forgvi-probe-workspace",
  sessionManager: SessionManager.inMemory(),
  noTools: "all",
});
if (modelFallbackMessage) console.log("fallback:", modelFallbackMessage);

let deltas = 0;
const events = [];
const unsub = session.subscribe((event) => {
  events.push(event.type);
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent?.type === "text_delta"
  ) {
    deltas++;
  }
});

await session.prompt("Reply with exactly: FORGVI KERNEL ONLINE");
unsub();

const last = [...session.messages].reverse().find((m) => m.role === "assistant");
const text = (last?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
console.log("event sequence:", events.join(" -> "));
console.log("text deltas:", deltas);
console.log("FINAL TEXT:", JSON.stringify(text));
session.dispose();
