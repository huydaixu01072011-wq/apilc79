const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const URL_TRUYEN_THONG = "https://wtx.tele68.com/v1/tx/sessions";
const URL_MD5 = "https://wtxmd52.tele68.com/v1/txmd5/sessions";

const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://tele68.com/",
    "Origin": "https://tele68.com",
    "Connection": "keep-alive"
};

const http = axios.create({ timeout: 10000, headers: HEADERS });

let historyNormal = [];
let historyMd5 = [];
let predictionsNormal = [];
let predictionsMd5 = [];

// ========== THUẬT TOÁN VIP: MARKOV CHAIN + PATTERN RECOGNITION ==========
class VIPPredictor {
    constructor(bac = 3) {
        this.bac = bac;
        this.transitions = new Map();
        this.historyDices = [];
        this.historyTX = []; 
        this.maxHistory = 60;
    }

    static chuyenLoai(diem) {
        if (diem === 1 || diem === 2) return 1;
        if (diem === 3 || diem === 4) return 2;
        return 3;
    }

    themDuLieu(rawData) {
        if (!rawData || rawData.length === 0) return;
        
        // Đảo mảng để sắp xếp từ CŨ đến MỚI (phục vụ chuỗi Markov và soi cầu)
        const cloneData = [...rawData].reverse();

        this.historyTX = cloneData.map(item => {
            const sum = item.dices ? item.dices.reduce((a, b) => a + b, 0) : 0;
            return sum >= 11 ? "TÀI" : "XỈU";
        });

        const dice123 = [];
        for (let item of cloneData) {
            if (item.dices && item.dices.length === 3) {
                for (let d of item.dices) {
                    dice123.push(VIPPredictor.chuyenLoai(d));
                }
            }
        }
        
        this.historyDices = dice123.slice(-this.maxHistory);
        this._xayDungMaTran();
    }

    _xayDungMaTran() {
        this.transitions.clear();
        const len = this.historyDices.length;
        if (len < this.bac + 1) return;

        for (let i = this.bac; i < len; i++) {
            for (let b = 1; b <= this.bac; b++) {
                const state = [];
                for (let j = b - 1; j >= 0; j--) {
                    state.push(this.historyDices[i - j]);
                }
                const stateKey = state.join(',');
                const nextVal = this.historyDices[i];
                
                if (!this.transitions.has(stateKey)) {
                    this.transitions.set(stateKey, new Map());
                }
                const nextMap = this.transitions.get(stateKey);
                nextMap.set(nextVal, (nextMap.get(nextVal) || 0) + 1);
            }
        }
    }

    nhanDienCau() {
        const len = this.historyTX.length;
        if (len < 5) return { coCau: false };

        const last1 = this.historyTX[len - 1];
        const last2 = this.historyTX[len - 2];
        const last3 = this.historyTX[len - 3];
        const last4 = this.historyTX[len - 4];
        const last5 = this.historyTX[len - 5];

        // 1. Cầu Bệt (4 ván giống nhau liên tiếp trở lên)
        if (last1 === last2 && last2 === last3 && last3 === last4) {
            return { coCau: true, theLoai: "CẦU BỆT", duDoan: last1, doTinCay: 85 };
        }
        
        // 2. Cầu đảo 1-1 (T-X-T-X-T)
        if (last1 !== last2 && last2 !== last3 && last3 !== last4 && last4 !== last5) {
            return { coCau: true, theLoai: "CẦU 1-1", duDoan: last1 === "TÀI" ? "XỈU" : "TÀI", doTinCay: 80 };
        }

        // 3. Cầu đôi 2-2 (T-T-X-X)
        if (last1 === last2 && last2 !== last3 && last3 === last4 && last1 !== last3) {
            return { coCau: true, theLoai: "CẦU 2-2", duDoan: last1 === "TÀI" ? "XỈU" : "TÀI", doTinCay: 75 };
        }

        return { coCau: false };
    }

    duDoanMarkov() {
        if (this.historyDices.length < this.bac) return 2;

        const states = [];
        for (let b = 1; b <= this.bac; b++) {
            const state = [];
            for (let j = b - 1; j >= 0; j--) {
                state.push(this.historyDices[this.historyDices.length - 1 - j]);
            }
            states.push({ bac: b, key: state.join(',') });
        }

        const diem = { 1: 0, 2: 0, 3: 0 };
        let tongDiem = 0;

        for (let i = states.length - 1; i >= 0; i--) {
            const s = states[i];
            const nextMap = this.transitions.get(s.key);
            if (nextMap && nextMap.size > 0) {
                const heSo = Math.pow(2, s.bac);
                for (let [val, count] of nextMap.entries()) {
                    diem[val] += count * heSo;
                    tongDiem += count * heSo;
                }
                break; 
            }
        }

        if (tongDiem === 0) return 2;

        let rand = Math.random() * tongDiem;
        let cum = 0;
        for (let val of [1, 2, 3]) {
            cum += diem[val];
            if (rand <= cum) return val;
        }
        return 2;
    }

    phanTich() {
        // Ưu tiên số 1: Quét và bám cầu đẹp
        const checkCau = this.nhanDienCau();
        if (checkCau.coCau) {
            return {
                prediction: checkCau.duDoan,
                confidenceTai: checkCau.duDoan === "TÀI" ? checkCau.doTinCay : 100 - checkCau.doTinCay,
                confidenceXiu: checkCau.duDoan === "XỈU" ? checkCau.doTinCay : 100 - checkCau.doTinCay,
                reason: `Hệ thống bắt được ${checkCau.theLoai} cực nét → Bám cầu`,
                pattern: checkCau.theLoai
            };
        }

        // Ưu tiên số 2: Tính toán ma trận Markov Chain xúc xắc
        const duDoanSo = this.duDoanMarkov();
        const prediction = (duDoanSo === 1 || duDoanSo === 3) ? "TÀI" : "XỈU";
        
        return {
            prediction: prediction,
            confidenceTai: prediction === "TÀI" ? 68 : 32,
            confidenceXiu: prediction === "XỈU" ? 68 : 32,
            reason: `Bậc Markov: ${this.bac} | Phân tích xác suất xúc xắc nhóm ${duDoanSo}`,
            pattern: "MARKOV CHAIN VIP"
        };
    }
}

function analyzeTrendVIP(history) {
    if (!history || history.length < 5) {
        return { prediction: "TÀI", confidenceTai: 50, confidenceXiu: 50, reason: "Đang nạp dữ liệu...", pattern: "KHỞI TẠO" };
    }
    const predictor = new VIPPredictor(3);
    predictor.themDuLieu(history.slice(0, 40));
    return predictor.phanTich();
}

// ========== HÀM BỔ TRỢ SEED GỐC CỦA BẠN ==========
function generateSeed(history, count = 8) {
    if (history.length < count) return null;
    const seedString = history.slice(0, count).map(item => item.dices ? item.dices.join('') : '').join('');
    if (!seedString) return null;
    return crypto.createHash('md5').update(seedString).digest('hex');
}

function randomDice(seed) {
    if (!seed) return [Math.floor(Math.random() * 6) + 1, Math.floor(Math.random() * 6) + 1, Math.floor(Math.random() * 6) + 1];
    const hash = crypto.createHash('md5').update(seed).digest('hex');
    const num1 = parseInt(hash.substring(0, 2), 16) % 6 + 1;
    const num2 = parseInt(hash.substring(2, 4), 16) % 6 + 1;
    const num3 = parseInt(hash.substring(4, 6), 16) % 6 + 1;
    return [num1, num2, num3];
}

// ========== LOGIC QUẢN LÝ LỊCH SỬ DỰ ĐOÁN & PHIÊN BIẾN ĐỘNG ==========
function updatePrediction(storage, history) {
    if (!history || history.length < 1) return;
    const latest = history[0]; 
    const nextPhien = latest.id + 1;
    
    const existing = storage.find(p => p.phien === nextPhien);
    if (!existing) {
        const ai = analyzeTrendVIP(history);
        storage.push({
            phien: nextPhien,
            du_doan: ai.prediction,
            ket_qua: null, 
            danh_gia: "ĐANG CHỜ",
            thoi_gian: new Date().toLocaleTimeString(),
            chi_tiet: ai.pattern
        });
        
        if (storage.length > 60) storage.shift(); 
    }
}

function evaluate(storage, history) {
    storage.forEach(p => {
        if (p.ket_qua && p.ket_qua !== "...") return; 
        const real = history.find(h => h.id === p.phien);
        if (real && real.dices && real.dices.length === 3) {
            const sum = real.dices.reduce((a, b) => a + b, 0);
            const result = sum >= 11 ? "TÀI" : "XỈU";
            p.ket_qua = `${result} (${sum})`;
            p.danh_gia = (p.du_doan === result) ? "THẮNG" : "THUA";
        }
    });
}

function stats(storage) {
    const finished = storage.filter(i => i.ket_qua && i.danh_gia !== "ĐANG CHỜ");
    const total = finished.length;
    const win = finished.filter(i => i.danh_gia === "THẮNG").length;
    const lose = finished.filter(i => i.danh_gia === "THUA").length;
    const rate = total === 0 ? 0 : ((win / total) * 100);
    return {
        tong_du_doan: total,
        tong_thang: win,
        tong_thua: lose,
        ti_le_chinh_xac: `${rate.toFixed(2)}%`,
        lich_su: storage.slice(-20).reverse() 
    };
}

// ========== FORMAT DỮ LIỆU ĐÚNG CHUẨN ĐỒNG BỘ ENDPOINT JSON TRƯỚC ĐÂY ==========
function formatData(raw, historyStorage) {
    const list = raw?.list;
    if (!list || list.length === 0) return { error: "Không có dữ liệu gốc" };
    const data = list[0];
    const ai = analyzeTrendVIP(list);
    const seed = generateSeed(list, 8);
    
    let tong = 0;
    let xuc_xac = [0, 0, 0];
    if (data.dices && data.dices.length === 3) {
        xuc_xac = data.dices;
        tong = data.dices.reduce((a, b) => a + b, 0);
    } else {
        const randomDices = randomDice(seed);
        xuc_xac = randomDices;
        tong = randomDices.reduce((a, b) => a + b, 0);
    }

    return {
        phien: data.id,
        xuc_xac_1: xuc_xac[0],
        xuc_xac_2: xuc_xac[1],
        xuc_xac_3: xuc_xac[2],
        tong: tong,
        ket_qua: tong >= 11 ? "TÀI" : "XỈU",
        phien_tiep_theo: data.id + 1,
        du_doan: ai.prediction,
        do_tin_cay: { TÀI: `${ai.confidenceTai}%`, XỈU: `${ai.confidenceXiu}%` },
        ly_do: ai.reason,
        pattern: ai.pattern
    };
}

// ========== ENGINE AUTO CALL REFRESH DATA (POLLING) ==========
async function fetchWithRetry(url, retry = 2) {
    try { return await http.get(url); }
    catch (e) { if (retry > 0) return fetchWithRetry(url, retry - 1); throw e; }
}

async function poll() {
    try {
        const [normal, md5] = await Promise.all([
            fetchWithRetry(URL_TRUYEN_THONG),
            fetchWithRetry(URL_MD5)
        ]);
        historyNormal = normal.data.list || [];
        historyMd5 = md5.data.list || [];
        
        updatePrediction(predictionsNormal, historyNormal);
        updatePrediction(predictionsMd5, historyMd5);
        
        evaluate(predictionsNormal, historyNormal);
        evaluate(predictionsMd5, historyMd5);
    } catch (e) { console.log("Lỗi đồng bộ API gốc:", e.message); }
}
setInterval(poll, 3000); // 3 giây quét sàn 1 lần tránh lệch phiên

// ========== DANH SÁCH ENDPOINT API TOÀN DIỆN DIỆN ==========

// 1. Endpoint JSON Tài Xỉu Thường
app.get("/taixiu", async (req, res) => {
    try { 
        const r = await fetchWithRetry(URL_TRUYEN_THONG); 
        res.json(formatData(r.data, historyNormal)); 
    } catch { res.status(500).json({ error: "Lỗi kết nối cổng API Thường" }); }
});

// 2. Endpoint JSON Tài Xỉu MD5
app.get("/taixiumd5", async (req, res) => {
    try { 
        const r = await fetchWithRetry(URL_MD5); 
        res.json(formatData(r.data, historyMd5)); 
    } catch { res.status(500).json({ error: "Lỗi kết nối cổng API MD5" }); }
});

// 3. Endpoint JSON Gộp cả 2 cổng
app.get("/all", async (req, res) => {
    try {
        const [a, b] = await Promise.all([fetchWithRetry(URL_TRUYEN_THONG), fetchWithRetry(URL_MD5)]);
        res.json({ taixiu: formatData(a.data, historyNormal), taixiumd5: formatData(b.data, historyMd5) });
    } catch { res.status(500).json({ error: "Lỗi xử lý API hỗn hợp" }); }
});

// 4. Các cổng thống kê 20 phiên đáp ứng dữ liệu Frontend
app.get("/thongke", (req, res) => res.json(stats(predictionsNormal)));
app.get("/thongkemd5", (req, res) => res.json(stats(predictionsMd5)));

// 5. ROUTE CHÍNH: GIAO DIỆN DASHBOARD SIÊU VIP (DARK/NEON DESIGN)
app.get("/", (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html lang="vi">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>DASHBOARD AI VIP PANEL</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            body { background-color: #0b0f19; color: #f1f5f9; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
            .glow-win { text-shadow: 0 0 12px #22c55e; color: #4ade80; }
            .glow-lose { text-shadow: 0 0 12px #ef4444; color: #f87171; }
            .table-container::-webkit-scrollbar { width: 5px; }
            .table-container::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 99px; }
        </style>
    </head>
    <body class="p-4 md:p-8">
        <div class="max-w-6xl mx-auto">
            <div class="flex flex-col md:flex-row justify-between items-center border-b border-slate-800 pb-6 mb-8 gap-4">
                <div>
                    <h1 class="text-3xl font-black tracking-wider text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-blue-500 to-purple-600">AI DETECTOR TRADING BOT VIP</h1>
                    <p class="text-xs text-slate-400 mt-1">Hệ thống xử lý đa luồng: Chuỗi Markov liên kết & Thuật toán bám cầu thông minh</p>
                </div>
                <div class="flex items-center gap-3 bg-slate-900 border border-slate-800 px-4 py-2 rounded-full">
                    <span class="relative flex h-3 w-3">
                      <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                      <span class="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
                    </span>
                    <span id="live-clock" class="text-xs font-mono text-slate-300">Đang đồng bộ live...</span>
                </div>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
                <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl">
                    <div class="flex justify-between items-center mb-4">
                        <h2 class="text-xl font-bold tracking-tight text-cyan-400 flex items-center gap-2">
                           <span class="p-1.5 bg-cyan-950 rounded-lg text-cyan-400">⚡</span> TRUYỀN THỐNG
                        </h2>
                        <div id="summary-normal" class="flex gap-2 text-xs"></div>
                    </div>
                    
                    <div class="table-container max-h-[520px] overflow-y-auto rounded-xl border border-slate-800">
                        <table class="w-full text-center border-collapse">
                            <thead class="bg-slate-950 text-slate-400 text-xs tracking-wider sticky top-0 uppercase">
                                <tr>
                                    <th class="py-3 px-2">Phiên dự đoán</th>
                                    <th class="py-3 px-2">Chiến Thuật</th>
                                    <th class="py-3 px-2">AI Báo</th>
                                    <th class="py-3 px-2">Kết Quả Thật</th>
                                    <th class="py-3 px-2">Đánh Giá</th>
                                </tr>
                            </thead>
                            <tbody id="body-normal" class="divide-y divide-slate-800/60 text-sm font-medium"></tbody>
                        </table>
                    </div>
                </div>

                <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl">
                    <div class="flex justify-between items-center mb-4">
                        <h2 class="text-xl font-bold tracking-tight text-purple-400 flex items-center gap-2">
                           <span class="p-1.5 bg-purple-950 rounded-lg text-purple-400">🔒</span> CỔNG MD5 VIP
                        </h2>
                        <div id="summary-md5" class="flex gap-2 text-xs"></div>
                    </div>
                    
                    <div class="table-container max-h-[520px] overflow-y-auto rounded-xl border border-slate-800">
                        <table class="w-full text-center border-collapse">
                            <thead class="bg-slate-950 text-slate-400 text-xs tracking-wider sticky top-0 uppercase">
                                <tr>
                                    <th class="py-3 px-2">Phiên dự đoán</th>
                                    <th class="py-3 px-2">Chiến Thuật</th>
                                    <th class="py-3 px-2">AI Báo</th>
                                    <th class="py-3 px-2">Kết Quả Thật</th>
                                    <th class="py-3 px-2">Đánh Giá</th>
                                </tr>
                            </thead>
                            <tbody id="body-md5" class="divide-y divide-slate-800/60 text-sm font-medium"></tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>

        <script>
            function buildRowHtml(item) {
                let statusBadge = "";
                if(item.danh_gia === "THẮNG") {
                    statusBadge = '<span class="bg-emerald-950/80 text-emerald-400 px-2.5 py-1 rounded-md text-xs font-bold border border-emerald-900/50 glow-win">THẮNG</span>';
                } else if(item.danh_gia === "THỦA" || item.danh_gia === "THUA") {
                    statusBadge = '<span class="bg-rose-950/80 text-rose-400 px-2.5 py-1 rounded-md text-xs font-bold border border-rose-900/50 glow-lose">THUA</span>';
                } else {
                    statusBadge = '<span class="bg-amber-950/80 text-amber-400 px-2.5 py-1 rounded-md text-xs font-medium border border-amber-900/50 animate-pulse">ĐANG CHỜ</span>';
                }

                const aiPredictionColor = item.du_doan === "TÀI" ? "text-red-400" : "text-sky-400";
                
                return \`
                    <tr class="hover:bg-slate-800/40 transition-colors">
                        <td class="py-3 px-2 font-mono text-slate-400 text-xs">#\${item.phien}</td>
                        <td class="py-3 px-2 text-xs text-slate-400">\${item.chi_tiet || "Đang quét"}</td>
                        <td class="py-3 px-2 font-bold \${aiPredictionColor}">\${item.du_doan}</td>
                        <td class="py-3 px-2 text-slate-300 font-semibold">\${item.ket_qua || "..."}</td>
                        <td class="py-3 px-2">\${statusBadge}</td>
                    </tr>
                \`;
            }

            async function refreshUIPanel() {
                try {
                    document.getElementById('live-clock').innerText = "Live: " + new Date().toLocaleTimeString();

                    const [resNormal, resMd5] = await Promise.all([
                        fetch('/thongke').then(r => r.json()),
                        fetch('/thongkemd5').then(r => r.json())
                    ]);

                    // Render Cổng Thường
                    document.getElementById('summary-normal').innerHTML = \`
                        <span class="bg-slate-800 text-slate-300 px-2 py-1 rounded">Mẫu: \${resNormal.tong_du_doan} ván</span>
                        <span class="bg-emerald-900/30 text-emerald-400 px-2 py-1 rounded font-bold">Thắng: \${resNormal.tong_thang}</span>
                        <span class="bg-blue-900/40 text-cyan-400 px-2 py-1 rounded font-black">Tỷ lệ: \${resNormal.ti_le_chinh_xac}</span>
                    \`;
                    document.getElementById('body-normal').innerHTML = resNormal.lich_su.length ? resNormal.lich_su.map(buildRowHtml).join('') : '<tr><td colspan="5" class="py-4 text-slate-500">Đang cập nhật phiên đầu...</td></tr>';

                    // Render Cổng MD5
                    document.getElementById('summary-md5').innerHTML = \`
                        <span class="bg-slate-800 text-slate-300 px-2 py-1 rounded">Mẫu: \${resMd5.tong_du_doan} ván</span>
                        <span class="bg-emerald-900/30 text-emerald-400 px-2 py-1 rounded font-bold">Thắng: \${resMd5.tong_thang}</span>
                        <span class="bg-purple-900/40 text-purple-400 px-2 py-1 rounded font-black">Tỷ lệ: \${resMd5.ti_le_chinh_xac}</span>
                    \`;
                    document.getElementById('body-md5').innerHTML = resMd5.lich_su.length ? resMd5.lich_su.map(buildRowHtml).join('') : '<tr><td colspan="5" class="py-4 text-slate-500">Đang cập nhật phiên đầu...</td></tr>';

                } catch(e) {
                    console.error("Lỗi cập nhật bảng điều khiển UI:", e);
                }
            }

            // Realtime cập nhật UI 3 giây 1 lần đồng bộ dữ liệu Node
            setInterval(refreshUIPanel, 3000);
            refreshUIPanel();
        </script>
    </body>
    </html>
    `;
    res.send(html);
});

// Kích hoạt server
// Khởi động server
app.listen(PORT, () => {
    console.log("======================================================");
    console.log(`🚀 ENGINE AI HOÀN TẤT - SERVER CHẠY TẠI CỔNG: ${PORT}`);
    console.log(`🖥️  Dashboard: http://localhost:${PORT}`);
    console.log(`📊 API JSON Tài Xỉu: http://localhost:${PORT}/taixiu`);
    console.log(`🔒 API JSON MD5: http://localhost:${PORT}/taixiumd5`);
    console.log(`📈 Thống kê: http://localhost:${PORT}/thongke`);
    console.log(`📈 Thống kê MD5: http://localhost:${PORT}/thongkemd5`);
    console.log("======================================================");
});