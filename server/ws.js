const { WebSocketServer } = require("ws");
const { v4: uuidv4 } = require("uuid");

const clients = new Map();

function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    let deviceId = null;

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      switch (msg.type) {
        case "register":
          deviceId = msg.deviceId;
          clients.set(deviceId, ws);
          ws._deviceId = deviceId;
          break;

        case "push_clip": {
          const target = clients.get(msg.targetDeviceId);
          if (target && target.readyState === 1) {
            target.send(
              JSON.stringify({
                type: "clip_pushed",
                clip: msg.clip,
                fromDeviceId: deviceId,
              })
            );
          }
          break;
        }

        case "new_clip": {
          for (const [cid, client] of clients) {
            if (cid !== deviceId && client.readyState === 1) {
              client.send(
                JSON.stringify({
                  type: "clip_created",
                  clip: msg.clip,
                  fromDeviceId: deviceId,
                })
              );
            }
          }
          break;
        }
      }
    });

    ws.on("close", () => {
      if (deviceId) clients.delete(deviceId);
    });
  });

  return wss;
}

module.exports = { setupWebSocket, clients };
