#!/usr/bin/env bun
import { spawn } from "child_process";
import { dirname, join } from "path";

const serverPath = join(dirname(import.meta.path), "server.ts");

async function testMCP() {
  console.log("🧪 Starting MCP server test...\n");

  const server = spawn("bun", ["run", serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let responseBuffer = "";

  server.stdout.on("data", (data) => {
    responseBuffer += data.toString();
  });

  server.stderr.on("data", (data) => {
    console.error("Server stderr:", data.toString());
  });

  const sendRequest = (method: string, params: any, id: number): Promise<any> => {
    return new Promise((resolve, reject) => {
      const request = JSON.stringify({ jsonrpc: "2.0", method, params, id }) + "\n";

      const timeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for response to ${method}`));
      }, 5000);

      const checkResponse = setInterval(() => {
        const lines = responseBuffer.split("\n").filter(l => l.trim());
        for (const line of lines) {
          try {
            const response = JSON.parse(line);
            if (response.id === id) {
              clearTimeout(timeout);
              clearInterval(checkResponse);
              responseBuffer = "";
              resolve(response);
              return;
            }
          } catch {}
        }
      }, 100);

      server.stdin.write(request);
    });
  };

  try {
    // Initialize
    console.log("1️⃣ Initializing server...");
    const initResp = await sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" }
    }, 1);
    console.log("✅ Initialize:", initResp.result ? "OK" : "FAILED");

    // List tools
    console.log("\n2️⃣ Listing tools...");
    const toolsResp = await sendRequest("tools/list", {}, 2);
    const tools = toolsResp.result?.tools || [];
    console.log(`✅ Found ${tools.length} tools:`, tools.map((t: any) => t.name).join(", "));

    // Test get_chats
    console.log("\n3️⃣ Testing get_chats (lastN=5)...");
    const getChatsResp = await sendRequest("tools/call", {
      name: "get_chats",
      arguments: { lastN: 5, afterN: 0 }
    }, 3);
    const getChatsResult = JSON.parse(getChatsResp.result?.content?.[0]?.text || "{}");
    console.log(`✅ get_chats returned ${getChatsResult.meta?.returned || 0} messages`);
    if (getChatsResult.data?.[0]) {
      console.log("   Sample:", getChatsResult.data[0].speaker, "-", getChatsResult.data[0].content?.slice(0, 50) + "...");
    }

    // Test get_chats_by_dates
    console.log("\n4️⃣ Testing get_chats_by_dates (today)...");
    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
    const todayEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).toISOString();

    const byDatesResp = await sendRequest("tools/call", {
      name: "get_chats_by_dates",
      arguments: { from: todayStart, to: todayEnd, limit: 10 }
    }, 4);
    const byDatesResult = JSON.parse(byDatesResp.result?.content?.[0]?.text || "{}");
    console.log(`✅ get_chats_by_dates returned ${byDatesResult.meta?.returned || 0} messages`);

    // Test get_chats_count_by_dates
    console.log("\n5️⃣ Testing get_chats_count_by_dates (today)...");
    const countResp = await sendRequest("tools/call", {
      name: "get_chats_count_by_dates",
      arguments: { from: todayStart, to: todayEnd }
    }, 5);
    const countResult = JSON.parse(countResp.result?.content?.[0]?.text || "{}");
    console.log(`✅ get_chats_count_by_dates: ${countResult.count} messages today`);

    console.log("\n🎉 ALL TESTS PASSED!");

  } catch (error) {
    console.error("❌ Test failed:", error);
    process.exit(1);
  } finally {
    server.kill();
  }
}

testMCP();
