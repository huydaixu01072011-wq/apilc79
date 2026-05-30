const express = require("express");
const axios = require("axios");
const WebSocket = require("ws");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("json spaces", 0);
app.use(express.json());

const client = axios.create({
    timeout: 15000,
    headers: {
        "User-Agent": "Mozilla/5.0 (Linux; Android 11; SM-A105G Build/RP1A.200720.012) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.120 Mobile Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "vi-VN,vi;q=0.9"
    }
});

// Helper: đặt cược qua WebSocket
function placeBetViaWebSocket(token, amount, choice, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const wsUrl = "wss://wtxmd52.tele68.com/txmd5?EIO=4&transport=websocket";
        let ws;
        let handshakeDone = false;
        let currentSid = null;
        let currentTickInfo = null;
        let betPlaced = false;
        let timeoutId;

        const cleanup = () => {
            if (timeoutId) clearTimeout(timeoutId);
            if (ws && ws.readyState === WebSocket.OPEN) ws.close();
        };

        timeoutId = setTimeout(() => {
            cleanup();
            reject(new Error("WebSocket timeout"));
        }, timeoutMs);

        ws = new WebSocket(wsUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Linux; Android 11; SM-A105G) AppleWebKit/537.36"
            }
        });

        ws.on("open", () => {
            // Không cần gửi gì ngay, server sẽ gửi message 0 đầu tiên
        });

        ws.on("message", (data) => {
            const msg = data.toString();
            
            // Message type 0: {"sid":"xxx","upgrades":[],"pingInterval":25000,...}
            if (msg.startsWith("0")) {
                try {
                    const jsonStr = msg.substring(1);
                    const openData = JSON.parse(jsonStr);
                    currentSid = openData.sid;
                    // Gửi authenticate với token
                    ws.send(`40/txmd5,{"token":"${token}"}`);
                    // Gửi xác nhận sid (theo log mẫu)
                    ws.send(`40/txmd5,{"sid":"${currentSid}"}`);
                    handshakeDone = true;
                } catch (e) {
                    reject(new Error("Parse open message failed: " + e.message));
                    cleanup();
                }
                return;
            }
            
            // Message type 40: thường là ack, bỏ qua
            if (msg.startsWith("40")) {
                return;
            }
            
            // Message type 42: event data
            if (msg.startsWith("42")) {
                // Format: "42/txmd5,{...}"
                const commaIndex = msg.indexOf(",");
                if (commaIndex === -1) return;
                const payload = msg.substring(commaIndex + 1);
                try {
                    const eventData = JSON.parse(payload);
                    // Kiểm tra event tick-update
                    if (eventData["tick-update"]) {
                        const update = eventData["tick-update"];
                        if (update.state === "BETTING") {
                            currentTickInfo = {
                                id: update.id,
                                tick: update.tick,
                                subTick: update.subTick
                            };
                            // Nếu chưa đặt cược và có tick info, tiến hành đặt
                            if (!betPlaced && currentTickInfo) {
                                betPlaced = true;
                                const betPayload = {
                                    "place-bet": {
                                        tickId: currentTickInfo.id,
                                        subTick: currentTickInfo.subTick,
                                        amount: amount,
                                        type: choice.toUpperCase()
                                    }
                                };
                                ws.send(`42/txmd5,${JSON.stringify(betPayload)}`);
                            }
                        }
                    }
                    
                    // Nhận kết quả đặt cược (giả định event "bet-result")
                    if (eventData["bet-result"]) {
                        const result = eventData["bet-result"];
                        cleanup();
                        resolve({
                            success: true,
                            result: result
                        });
                    }
                    
                    // Xử lý lỗi
                    if (eventData["error"]) {
                        cleanup();
                        reject(new Error(eventData["error"].message || "Bet error"));
                    }
                } catch (e) {
                    // Không parse được, bỏ qua
                }
                return;
            }
            
            // Ping (type 2) -> pong (type 3)
            if (msg === "2") {
                ws.send("3");
                return;
            }
        });
        
        ws.on("error", (err) => {
            cleanup();
            reject(new Error("WebSocket error: " + err.message));
        });
        
        ws.on("close", () => {
            if (!betPlaced) {
                cleanup();
                reject(new Error("WebSocket closed before bet placed"));
            }
        });
    });
}

// Endpoint đặt cược
app.post("/bet", async (req, res) => {
    let { token, amount, choice, user, pass } = req.body;
    
    // Nếu có user/pass thì tự động login lấy token
    if (user && pass) {
        try {
            const apiUrl = `https://apifo88daigia.tele68.com/api?c=3&un=${encodeURIComponent(user)}&pw=${encodeURIComponent(pass)}&cp=R&cl=R&pf=web&at=`;
            const response = await client.get(apiUrl);
            const data = response.data;
            if (!data.success) {
                return res.json({ success: false, errorCode: data.errorCode || "Login failed" });
            }
            token = data.sessionKey; // JWT token
        } catch (err) {
            return res.json({ success: false, message: err.message });
        }
    }
    
    if (!token) {
        return res.json({ success: false, message: "Thiếu token hoặc user/pass" });
    }
    if (!amount || amount <= 0) {
        return res.json({ success: false, message: "Số tiền không hợp lệ" });
    }
    if (!choice || (choice.toUpperCase() !== "TAI" && choice.toUpperCase() !== "XIU")) {
        return res.json({ success: false, message: "Choice phải là TAI hoặc XIU" });
    }
    
    try {
        const result = await placeBetViaWebSocket(token, Number(amount), choice);
        res.json({ success: true, data: result });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
});

// Các endpoint cũ giữ nguyên
app.get("/", (req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.send(JSON.stringify({
        success: true,
        author: "HuyDaiXu",
        status: "online",
        endpoint: "/login?user=&pass="
    }));
});

app.get("/login", async (req, res) => {
    const { user, pass } = req.query;
    if (!user || !pass) {
        return res.json({ success: false, message: "Thiếu user hoặc pass" });
    }
    try {
        const apiUrl = `https://apifo88daigia.tele68.com/api?c=3&un=${encodeURIComponent(user)}&pw=${encodeURIComponent(pass)}&cp=R&cl=R&pf=web&at=`;
        const response = await client.get(apiUrl);
        const data = response.data;
        if (!data.success) {
            return res.json({ success: false, errorCode: data.errorCode || "UNKNOWN" });
        }
        let info = {};
        try {
            if (data.sessionKey.includes(".")) {
                info = JSON.parse(Buffer.from(data.sessionKey.split(".")[1], "base64").toString());
            } else {
                info = JSON.parse(Buffer.from(data.sessionKey, "base64").toString());
            }
        } catch (e) {}
        res.json({
            success: true,
            username: user,
            nickname: info.nickname || null,
            balance: info.vinTotal || 0,
            vipLevel: data.curLevel || 0,
            createTime: info.createTime || null,
            ipAddress: info.ipAddress || null,
            accessToken: data.accessToken || null,
            sessionKey: data.sessionKey || null
        });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`API running on port ${PORT}`);
});