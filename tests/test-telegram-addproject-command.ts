import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SlotDB } from "../src/db/slot-db.js";
import { DefaultMemoryUseCasePort } from "../src/core/usecases/default-memory-usecase-port.js";
import {
  composeAddProjectScopeUserId,
  parseAddProjectCommandArgs,
  registerTelegramAddProjectCommand,
} from "../src/commands/telegram-addproject-command.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\nactual=${a}\nexpected=${e}`);
}

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

const ROOT = mkdtempSync(join(tmpdir(), "agent-smart-memo-addproject-cmd-"));
const db = new SlotDB(ROOT, { slotDbDir: join(ROOT, "slotdb") });
const useCasePort = new DefaultMemoryUseCasePort(db);

function createApiStub() {
  const commands: any[] = [];
  return {
    api: {
      pluginConfig: {},
      config: {},
      registerCommand(command: any) {
        commands.push(command);
      },
    } as any,
    commands,
  };
}

test("parseAddProjectCommandArgs parses positional and key=value tokens", () => {
  const parsed = parseAddProjectCommandArgs(
    "confirm git@github.com:cong91/agent-smart-memo.git alias=asm-main jira=asm epic=asm-82 index=true",
  ) as any;

  assertEqual(parsed.mode, "confirm", "mode should be confirm");
  assertEqual(parsed.repo_url, "git@github.com:cong91/agent-smart-memo.git", "repo_url should parse");
  assertEqual(parsed.project_alias, "asm-main", "alias should parse");
  assertEqual(parsed.jira_space_key, "ASM", "jira key should normalize uppercase");
  assertEqual(parsed.default_epic_key, "ASM-82", "epic should normalize uppercase");
  assertEqual(parsed.index_now, true, "index flag should parse boolean");
});

test("composeAddProjectScopeUserId includes channel/account/sender/thread for account-safe scoping", () => {
  const id = composeAddProjectScopeUserId({
    channel: "telegram",
    accountId: "ops",
    senderId: "5165741309",
    messageThreadId: 42,
    isAuthorizedSender: true,
    commandBody: "/addproject",
    config: {},
  } as any);

  assertEqual(id, "telegram:account:ops:sender:5165741309:thread:42", "scope userId should include account/thread");
});

test("registerTelegramAddProjectCommand registers /addproject behavior and routes to project.telegram_onboarding", async () => {
  const { api, commands } = createApiStub();

  registerTelegramAddProjectCommand(api, {
    now: () => 1700000000000,
    getUseCasePortForContext: () => useCasePort,
  });

  assert(commands.length >= 1, "registerCommand should be called");
  const addproject = commands.find((c) => c.name === "addproject");
  assert(Boolean(addproject), "addproject command should be registered");

  const previewRes = await addproject.handler({
    channel: "telegram",
    accountId: "default",
    senderId: "5165741309",
    isAuthorizedSender: true,
    args: "git@github.com:cong91/agent-smart-memo.git alias=asm-preview jira=ASM mode=preview",
    commandBody: "/addproject git@github.com:cong91/agent-smart-memo.git alias=asm-preview jira=ASM mode=preview",
    config: {},
  });

  assert(typeof previewRes?.text === "string", "preview should return text payload");
  assert(previewRes.text.includes("/addproject"), "preview text should mention /addproject");
  assert(previewRes.text.includes("preview") || previewRes.text.includes("validation"), "preview text should describe status");

  const confirmRes = await addproject.handler({
    channel: "telegram",
    accountId: "default",
    senderId: "5165741309",
    isAuthorizedSender: true,
    args: "confirm git@github.com:cong91/agent-smart-memo.git alias=asm-confirm jira=ASM epic=ASM-82 index=true",
    commandBody: "/addproject confirm git@github.com:cong91/agent-smart-memo.git alias=asm-confirm jira=ASM epic=ASM-82 index=true",
    config: {},
  });

  assert(typeof confirmRes?.text === "string", "confirm should return text payload");
  assert(confirmRes.text.includes("committed"), "confirm text should include committed status");
  assert(confirmRes.text.includes("asm-confirm"), "confirm text should include project alias");
});

async function run() {
  let passed = 0;
  let failed = 0;

  for (const t of tests) {
    try {
      await t.fn();
      console.log(`✅ ${t.name}`);
      passed += 1;
    } catch (error) {
      console.error(`❌ ${t.name}`);
      console.error(error instanceof Error ? error.message : String(error));
      failed += 1;
    }
  }

  db.close();
  rmSync(ROOT, { recursive: true, force: true });

  console.log(`\n📊 addproject command tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
