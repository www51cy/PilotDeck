import { readFile, writeFile } from "node:fs/promises";
import {
  GatewayBrowserClient,
  readLocalGatewayToken,
} from "../../src/web/client/GatewayBrowserClient.ts";

const base = "http://127.0.0.1:18789";
const mode = process.argv[2];
const statePath = new URL("./auto-01-pilotdeck-session.json", import.meta.url);
const outputPath = new URL(`./auto-01-pilotdeck-${mode}.json`, import.meta.url);
const token = await readLocalGatewayToken(undefined, `${base}/auth/local-token`);
const client = new GatewayBrowserClient({
  url: "ws://127.0.0.1:18789/ws",
  token,
  clientName: "test",
  clientVersion: "auto-01",
});
const timeout = setTimeout(() => {
  console.error("AUTO-01 probe timed out");
  client.close();
  process.exitCode = 2;
}, 90_000);

try {
  const hello = await client.connect();
  const record = { mode, protocolVersion: hello.protocolVersion };

  if (mode === "invalid-rpc") {
    try {
      await client.request("auto_01_unknown_method", {});
      record.unexpectedSuccess = true;
    } catch (error) {
      record.error = {
        name: error.name,
        code: error.code,
        message: error.message,
      };
    }
  } else {
    let sessionKey;
    let message;
    let modelOverride;
    let maxTurns;
    if (mode === "initial" || mode === "structured") {
      ({ sessionKey } = await client.newSession({
        projectKey: "/root/pilotdeck",
        channelKey: "test",
        hint: `AUTO-01 ${mode} headless probe`,
      }));
      await writeFile(statePath, JSON.stringify({ sessionKey }, null, 2));
      if (mode === "structured") {
        message = '请调用 structured_output 工具，把 {"status":"PILOT_STRUCTURED_OK"} 作为 value。';
        maxTurns = 1;
      } else {
        message = "只回复 PILOT_OK，不要调用任何工具。";
      }
    } else {
      ({ sessionKey } = JSON.parse(await readFile(statePath, "utf8")));
      await client.resumeSession({ sessionKey });
      if (mode === "resume") {
        message = "上一轮我要求你只回复哪个英文标记？只回复那个标记，不要调用任何工具。";
      } else if (mode === "invalid-model") {
        message = "只回复 SHOULD_NOT_SUCCEED，不要调用任何工具。";
        modelOverride = {
          mode: "model",
          provider: "volc_ark",
          model: "auto-01-deliberately-missing-model",
        };
      } else {
        throw new Error(`Unknown probe mode: ${mode}`);
      }
    }

    const events = [];
    for await (const event of client.submitTurn({
      sessionKey,
      channelKey: "test",
      projectKey: "/root/pilotdeck",
      message,
      canPrompt: false,
      ...(modelOverride ? { modelOverride } : {}),
      ...(maxTurns ? { maxTurns } : {}),
    })) {
      events.push(event);
    }
    record.sessionKey = sessionKey;
    record.events = events;
    record.text = events
      .filter((event) => event.type === "assistant_text_delta")
      .map((event) => event.text)
      .join("");
    record.completed = events.filter((event) => event.type === "turn_completed");
    record.errors = events.filter((event) => event.type === "error");
  }

  await writeFile(outputPath, JSON.stringify(record, null, 2));
  console.log(JSON.stringify({
    mode,
    sessionKey: record.sessionKey,
    eventTypes: record.events?.map((event) => event.type),
    text: record.text,
    completed: record.completed,
    errors: record.errors,
    error: record.error,
    unexpectedSuccess: record.unexpectedSuccess,
  }));
} finally {
  clearTimeout(timeout);
  client.close();
}
