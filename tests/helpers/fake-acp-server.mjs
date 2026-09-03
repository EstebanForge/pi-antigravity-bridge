// Scripted fake ACP server for driver tests (stdio JSONL, same wire shape as
// agy_acp_server). Scenario selection via ACP_FAKE_SCENARIO; every received
// request is logged to ACP_FAKE_LOG (one JSON per line) so tests can assert on
// the exact protocol traffic the driver produced.
//
// Scenarios:
//   happy              prompt -> chunks "HE","LLO" -> end_turn
//   permission         prompt -> request_permission (waits for the client's
//                      answer) -> chunks "PER","MIS" -> end_turn
//   cancel-unsupported prompt -> chunk "C1" then chunks every 150ms forever;
//                      session/cancel -> -32601 (RC01 behavior)
//   slow               prompt -> nothing, ever (deadline tests)
//   load-replay        session/load -> full-text history replay pairs, then
//                      prompt -> chunks "LIVE-1","LIVE-2" -> end_turn
//   auth-required      session/new -> -32000
//   load-fails         session/load -> -32000 (driver must fall back to new)
//   park               prompt -> chunk "P1", then after 2500ms "P2" + end_turn
//                      (overall-timer pause tests: park past a tight deadline)

import fs from "node:fs";
import readline from "node:readline";

const scenario = process.env.ACP_FAKE_SCENARIO || "happy";
const sessionId = "fake-session-0001";
let pendingPromptId = null;
let streaming = false;
const timers = [];

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}
function error(id, code, message, data) {
  send({ jsonrpc: "2.0", id, error: { code, message, data } });
}
function notifyChunk(text) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
  });
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const logPath = process.env.ACP_FAKE_LOG || null;
const logStream = logPath ? fs.createWriteStream(logPath) : null;
function logReq(obj) {
  if (logStream) logStream.write(JSON.stringify(obj) + "\n");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  logReq(msg);
  void handle(msg).catch(() => {});
});
rl.on("close", () => {
  for (const t of timers) clearTimeout(t);
});

async function handle(msg) {
  const { id, method, params } = msg;

  // Client response to our request_permission probe (permission scenario).
  if (method === undefined && id === 100) {
    const optionId = msg.result?.outcome?.optionId;
    logReq({ _permissionAnswer: optionId });
    await streamPrompt();
    return;
  }

  switch (method) {
    case "initialize":
      result(id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: true, embeddedContext: true },
          mcpCapabilities: { http: true, sse: true },
          sessionCapabilities: { list: {}, resume: {} },
          auth: { logout: {} },
        },
        authMethods: [],
        agentInfo: { name: "fake-acp", title: "Fake ACP", version: "fake-1" },
      });
      return;

    case "authenticate":
      result(id, {});
      return;

    case "session/new":
      if (scenario === "auth-required") {
        error(id, -32000, "Authentication required", { message: "run /agy acp-auth" });
        return;
      }
      result(id, {
        sessionId,
        modes: { currentModeId: "default", availableModes: [] },
        models: { availableModels: [], currentModelId: "fake-model" },
        configOptions: [],
      });
      return;

    case "session/load":
      if (scenario === "load-replay") {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "OLD USER" } },
          },
        });
        notifyChunk("OLD REPLY FULL TEXT");
      }
      if (scenario === "load-fails") {
        error(id, -32000, "unknown session");
        return;
      }
      result(id, { configOptions: [] });
      return;

    case "session/set_config_option":
      result(id, {
        configOptions: [
          { id: params.configId, currentValue: params.value, options: [], type: "select", name: params.configId, category: params.configId },
        ],
      });
      return;

    case "session/prompt": {
      pendingPromptId = id;
      if (scenario === "permission") {
        send({
          jsonrpc: "2.0",
          id: 100,
          method: "session/request_permission",
          params: {
            sessionId,
            toolCall: { toolCallId: "t1", kind: "edit", status: "pending", title: "Run create_file?" },
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          },
        });
        return; // resumed by the client's response above
      }
      await streamPrompt();
      return;
    }

    case "session/cancel":
      if (scenario === "cancel-unsupported") {
        error(id, -32601, "Method not found", { method: "session/cancel" });
        return;
      }
      if (pendingPromptId !== null) {
        result(pendingPromptId, { stopReason: "cancelled" });
        pendingPromptId = null;
      }
      result(id, {});
      return;

    case "session/close":
      result(id, {});
      return;

    default:
      error(id, -32601, "Method not found", { method });
  }
}

async function streamPrompt() {
  if (streaming) return;
  streaming = true;
  if (scenario === "slow") return; // never emits, never completes
  if (scenario === "cancel-unsupported") {
    notifyChunk("C1");
    const t = setInterval(() => {
      if (pendingPromptId === null) {
        clearInterval(t);
        return;
      }
      notifyChunk("tick");
    }, 150);
    timers.push(t);
    return;
  }
  if (scenario === "park") {
    notifyChunk("P1");
    const t = setTimeout(() => {
      notifyChunk("P2");
      if (pendingPromptId !== null) {
        result(pendingPromptId, { stopReason: "end_turn" });
        pendingPromptId = null;
      }
    }, 2500);
    timers.push(t);
    return;
  }
  if (scenario === "load-replay") {
    notifyChunk("LIVE-1");
    await sleep(20);
    notifyChunk("LIVE-2");
    if (pendingPromptId !== null) {
      result(pendingPromptId, { stopReason: "end_turn" });
      pendingPromptId = null;
    }
    return;
  }
  // happy / permission
  notifyChunk(scenario === "permission" ? "PER" : "HE");
  await sleep(20);
  notifyChunk(scenario === "permission" ? "MIS" : "LLO");
  if (pendingPromptId !== null) {
    result(pendingPromptId, { stopReason: "end_turn" });
    pendingPromptId = null;
  }
}
