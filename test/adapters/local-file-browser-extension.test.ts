import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { LocalExtensionDirectoryResolver } from "../../src/adapters/local-extension-directory-resolver.js";
import { LocalFileBrowser } from "../../src/adapters/local-file-browser.js";
import { SqliteAgentStore } from "../../src/adapters/sqlite-agent-store.js";
import { SqliteConversationStore } from "../../src/adapters/sqlite-conversation-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { createSecretCipher } from "../../src/util/secret-cipher.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("LocalFileBrowser extension scope", () => {
  it("owner 可浏览扩展目录，共享访问者被拒绝", async () => {
    const root = mkdtempSync(join(tmpdir(), "file-extension-"));
    roots.push(root);
    const db = new Database(":memory:");
    const userStore = new SqliteUserStore(db, {
      adminExternalIds: new Set(),
      usersDir: join(root, "users"),
    });
    userStore.migrate();
    const conversationStore = new SqliteConversationStore(db);
    conversationStore.migrate();
    const agentStore = new SqliteAgentStore(db, createSecretCipher("test"));
    agentStore.migrate();
    const owner = await userStore.getOrCreateByIdentity("internal", "owner", "Owner");
    const visitor = await userStore.getOrCreateByIdentity("internal", "visitor", "Visitor");
    // 扩展目录已改版为相对路径：锚定属主工作区根（owner.homeDir）
    const extension = join(owner.homeDir, "external-docs");
    mkdirSync(extension, { recursive: true });
    writeFileSync(join(extension, "README.md"), "docs");
    const agent = await agentStore.create({
      ownerId: owner.id,
      name: "A",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      llm: {},
      extensionDirectories: [
        { id: "docs", name: "文档", path: "external-docs", access: "readOnly" },
      ],
    });
    const ownerConversation = await conversationStore.createWithAgent(
      owner.id,
      "web",
      "A",
      agent.id,
    );
    const visitorConversation = await conversationStore.createWithAgent(
      visitor.id,
      "web",
      "A",
      agent.id,
    );
    const browser = new LocalFileBrowser({
      userStore,
      conversationStore,
      workspaceDir: root,
      agentStore,
      extensionDirectoryResolver: new LocalExtensionDirectoryResolver(),
    });

    const nodes = await browser.listTree(owner.id, "extension", ownerConversation.id);
    expect(nodes[0]?.name).toBe("文档");
    expect(nodes[0]?.children?.[0]?.name).toBe("README.md");
    await expect(browser.listTree(visitor.id, "extension", visitorConversation.id)).rejects.toThrow(
      "共享智能体",
    );
    db.close();
  });
});
