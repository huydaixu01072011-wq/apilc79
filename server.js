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

// ========== VIP BRAIN ENGINE ==========
class VIPBrain {
    constructor(maxOrder = 4) {
        this.maxOrder = maxOrder;
        this.transitionMatrices = {};
        this.diceHistory = [];
        this.txHistory = [];
        this.maxHistory = 80;
        this.bayesian = { TAI: 0.5, XIU: 0.5 };
    }

    static diceCategory(diem) {
        if (diem === 1 || diem === 2) return 1;
        if (diem === 3 || diem === 4) return 2;
        return 3;
    }

    loadData(rawList) {
        if (!rawList || rawList.length === 0) return;
        const clone = [...rawList].reverse();
        this.txHistory = clone.map(item => {
            if (!item.dices || item.dices.length !== 3) return null;
            const sum = item.dices.reduce((a, b) => a + b, 0);
            return sum >= 11 ? "TÀI" : "XỈU";
        }).filter(Boolean);
        this.diceHistory = [];
        clone.forEach(item => {
            if (item.dices && item.dices.length === 3) {
                item.dices.forEach(d => this.diceHistory.push(VIPBrain.diceCategory(d)));
            }
        });
        if (this.diceHistory.length > this.maxHistory) {
            this.diceHistory = this.diceHistory.slice(-this.maxHistory);
        }
        this._buildTransitionMatrices();
        this._updateBayesian();
    }

    _buildTransitionMatrices() {
        this.transitionMatrices = {};
        const len = this.diceHistory.length;
        for (let order = 1; order <= this.maxOrder; order++) {
            const matrix = new Map();
            if (len > order) {
                for (let i = order; i < len; i++) {
                    const state = [];
                    for (let j = order - 1; j >= 0; j--) {
                        state.push(this.diceHistory[i - j]);
                    }
                    const key = state.join(',');
                    const nextVal = this.diceHistory[i];
                    if (!matrix.has(key)) matrix.set(key, new Map());
                    const counts = matrix.get(key);
                    counts.set(nextVal, (counts.get(nextVal) || 0) + 1);
                }
            }
            this.transitionMatrices[order] = matrix;
        }
    }

    _updateBayesian() {
        const recent = this.txHistory.slice(-30);
        const countTai = recent.filter(r => r === "TÀI").length;
        const countXiu = recent.length - countTai;
        const alpha = 1;
        this.bayesian.TAI = (countTai + alpha) / (recent.length + 2 * alpha);
        this.bayesian.XIU = (countXiu + alpha) / (recent.length + 2 * alpha);
    }

    _predictMarkov() {
        const len = this.diceHistory.length;
        if (len < 1) return { category: 2, confidence: 0.5 };
        for (let order = this.maxOrder; order >= 1; order--) {
            if (len < order) continue;
            const state = [];
            for (let j = order - 1; j >= 0; j--) {
                state.push(this.diceHistory[len - 1 - j]);
            }
            const key = state.join(',');
            const matrix = this.transitionMatrices[order];
            if (matrix && matrix.has(key)) {
                const nextCounts = matrix.get(key);
                let total = 0;
                for (let count of nextCounts.values()) total += count;
                let bestCat = 2, bestProb = 0;
                for (let [cat, cnt] of nextCounts.entries()) {
                    const prob = cnt / total;
                    if (prob > bestProb) { bestProb = prob; bestCat = cat; }
                }
                return { category: bestCat, confidence: bestProb };
            }
        }
        const counts = { 1: 0, 2: 0, 3: 0 };
        this.diceHistory.forEach(c => counts[c]++);
        const total = this.diceHistory.length;
        let bestCat = 2, bestProb = 0;
        for (let c of [1, 2, 3]) {
            const p = counts[c] / total;
            if (p > bestProb) { bestProb = p; bestCat = c; }
        }
        return { category: bestCat, confidence: bestProb };
    }

    _detectPattern() {
        const tx = this.txHistory;
        const len = tx.length;
        if (len < 6) return null;
        const last = tx.slice(-6);
        const match = (pattern) => {
            if (pattern.length > last.length) return false;
            for (let i = 0; i < pattern.length; i++) {
                if (last[last.length - pattern.length + i] !== pattern[i]) return false;
            }
            return true;
        };
        const patterns = [
            { name: "BỆT TÀI", seq: ["TÀI","TÀI","TÀI","TÀI"], next: "TÀI", confidence: 90 },
            { name: "BỆT XỈU", seq: ["XỈU","XỈU","XỈU","XỈU"], next: "XỈU", confidence: 90 },
            { name: "1-1 TÀI", seq: ["XỈU","TÀI","XỈU","TÀI"], next: "XỈU", confidence: 85 },
            { name: "1-1 XỈU", seq: ["TÀI","XỈU","TÀI","XỈU"], next: "TÀI", confidence: 85 },
            { name: "2-2 TÀI", seq: ["TÀI","TÀI","XỈU","XỈU","TÀI"], next: "TÀI", confidence: 82 },
            { name: "2-2 XỈU", seq: ["XỈU","XỈU","TÀI","TÀI","XỈU"], next: "XỈU", confidence: 82 },
            { name: "3-1 TÀI", seq: ["TÀI","TÀI","TÀI","XỈU"], next: "TÀI", confidence: 80 },
            { name: "3-1 XỈU", seq: ["XỈU","XỈU","XỈU","TÀI"], next: "XỈU", confidence: 80 },
            { name: "CẦU ĐẢO 2-1", seq: ["TÀI","TÀI","XỈU","TÀI","XỈU"], next: "TÀI", confidence: 78 },
            { name: "CẦU ĐẢO 2-1 (ngược)", seq: ["XỈU","XỈU","TÀI","XỈU","TÀI"], next: "XỈU", confidence: 78 },
        ];
        for (let p of patterns) {
            if (match(p.seq)) return { name: p.name, prediction: p.next, confidence: p.confidence };
        }
        return null;
    }

    // ========== NHẬN DIỆN BẺ CẦU ==========
    _detectBreak() {
        const tx = this.txHistory;
        const len = tx.length;
        if (len < 5) return null;

        const last6 = tx.slice(-6); // 6 phiên gần nhất

        // Kiểm tra bệt bị bẻ: 3 hoặc 4 phiên giống nhau rồi phiên cuối khác
        const isBệtBreak = (arr, value) => {
            if (arr.length < 4) return false;
            const last = arr[arr.length - 1];
            if (last === value) return false; // phiên cuối vẫn giống -> chưa bẻ
            const prev = arr.slice(0, -1);
            return prev.every(v => v === value) && prev.length >= 3; // ít nhất 3 phiên giống
        };

        if (isBệtBreak(last6, "TÀI")) {
            return { isBreak: true, prediction: "XỈU", confidence: 88, name: "BẺ BỆT TÀI" };
        }
        if (isBệtBreak(last6, "XỈU")) {
            return { isBreak: true, prediction: "TÀI", confidence: 88, name: "BẺ BỆT XỈU" };
        }

        // Kiểm tra cầu 1-1 bị bẻ: mẫu T-X-T-X nhưng phiên cuối đi cùng hướng với áp cuối
        const check11Break = (arr, startWith) => {
            if (arr.length < 5) return false;
            const expect = startWith === "TÀI" ? ["TÀI","XỈU","TÀI","XỈU","TÀI"] : ["XỈU","TÀI","XỈU","TÀI","XỈU"];
            for (let i = 0; i < 5; i++) {
                if (i < 4 && arr[arr.length - 5 + i] !== expect[i]) return false;
            }
            // Phiên thứ 5 (cuối cùng) lẽ ra phải là expect[4] nhưng thực tế là arr[arr.length-1]
            const actualLast = arr[arr.length - 1];
            return actualLast === expect[3]; // trùng với áp cuối -> bẻ
        };

        if (check11Break(last6, "TÀI")) {
            return { isBreak: true, prediction: "TÀI", confidence: 82, name: "BẺ CẦU 1-1 (TÀI)" };
        }
        if (check11Break(last6, "XỈU")) {
            return { isBreak: true, prediction: "XỈU", confidence: 82, name: "BẺ CẦU 1-1 (XỈU)" };
        }

        return null; // không có dấu hiệu bẻ rõ ràng
    }

    _trendAnalysis() {
        const recent = this.txHistory.slice(-20);
        if (recent.length < 10) return { trend: "SIDEWAY", strength: 0 };
        const taiCount = recent.filter(r => r === "TÀI").length;
        const ratio = taiCount / recent.length;
        const ema = ratio * 0.3 + 0.5 * 0.7; // EMA cố định alpha=0.3
        if (ema > 0.55) return { trend: "TÀI", strength: (ema - 0.5) * 2 };
        if (ema < 0.45) return { trend: "XỈU", strength: (0.5 - ema) * 2 };
        return { trend: "SIDEWAY", strength: 1 - Math.abs(ema - 0.5) * 2 };
    }

    analyze() {
        const markov = this._predictMarkov();
        let probTai_Markov = 0.5;
        if (markov.category === 3) probTai_Markov = 0.7;
        else if (markov.category === 1) probTai_Markov = 0.3;

        const pattern = this._detectPattern();
        let probTai_Pattern = 0.5;
        let patternName = "KHÔNG CẦU";
        if (pattern) {
            probTai_Pattern = pattern.prediction === "TÀI" ? pattern.confidence / 100 : 1 - pattern.confidence / 100;
            patternName = pattern.name;
        }

        const breakInfo = this._detectBreak();
        let probTai_Break = 0.5;
        let breakName = "KHÔNG BẺ";
        if (breakInfo && breakInfo.isBreak) {
            probTai_Break = breakInfo.prediction === "TÀI" ? breakInfo.confidence / 100 : 1 - breakInfo.confidence / 100;
            breakName = breakInfo.name;
        }

        const trend = this._trendAnalysis();
        let probTai_Trend = 0.5;
        if (trend.trend === "TÀI") probTai_Trend = 0.5 + trend.strength * 0.5;
        else if (trend.trend === "XỈU") probTai_Trend = 0.5 - trend.strength * 0.5;

        const probTai_Bayes = this.bayesian.TAI;

        // Trọng số ensemble mới: Markov 30%, Pattern 25%, Bẻ cầu 25%, Trend 15%, Bayes 5%
        const finalProbTai = probTai_Markov * 0.30 +
                             probTai_Pattern * 0.25 +
                             probTai_Break * 0.25 +
                             probTai_Trend * 0.15 +
                             probTai_Bayes * 0.05;

        const prediction = finalProbTai >= 0.5 ? "TÀI" : "XỈU";
        const confidenceTai = Math.round(finalProbTai * 100);
        const confidenceXiu = 100 - confidenceTai;

        let reason = `Markov(${markov.category},${Math.round(markov.confidence*100)}%) `;
        if (patternName !== "KHÔNG CẦU") reason += `+ ${patternName} `;
        if (breakName !== "KHÔNG BẺ") reason += `+ ${breakName} `;
        reason += `| Trend ${trend.trend} | Bayes T=${Math.round(probTai_Bayes*100)}%`;

        return {
            prediction,
            confidenceTai,
            confidenceXiu,
            reason,
            pattern: breakName !== "KHÔNG BẺ" ? breakName : patternName
        };
    }
}

const brainNormal = new VIPBrain(4);
const brainMd5 = new VIPBrain(4);

// ========== CẬP NHẬT DỮ LIỆU ==========
function feedBrain(brain, rawList) {
    if (rawList && rawList.length > 0) brain.loadData(rawList);
}

async function poll() {
    try {
        const [normal, md5] = await Promise.all([
            http.get(URL_TRUYEN_THONG).catch(() => null),
            http.get(URL_MD5).catch(() => null)
        ]);
        if (normal?.data?.list) {
            historyNormal = normal.data.list;
            feedBrain(brainNormal, historyNormal);
            updatePredictionTable(predictionsNormal, historyNormal, brainNormal);
            evaluatePredictions(predictionsNormal, historyNormal);
        }
        if (md5?.data?.list) {
            historyMd5 = md5.data.list;
            feedBrain(brainMd5, historyMd5);
            updatePredictionTable(predictionsMd5, historyMd5, brainMd5);
            evaluatePredictions(predictionsMd5, historyMd5);
        }
    } catch (e) {
        console.log("Poll error:", e.message);
    }
}
setInterval(poll, 3000);

function updatePredictionTable(storage, history, brain) {
    if (!history || history.length === 0) return;
    const latest = history[0];
    const nextPhien = latest.id + 1;
    if (!storage.find(p => p.phien === nextPhien)) {
        const ai = brain.analyze();
        storage.push({
            phien: nextPhien,
            du_doan: ai.prediction,
            ket_qua: null,
            danh_gia: "ĐANG CHỜ",
            thoi_gian: new Date().toLocaleTimeString(),
            chi_tiet: ai.pattern,
            ly_do: ai.reason,
            do_tin_cay: `${ai.confidenceTai}%`
        });
        if (storage.length > 60) storage.shift();
    }
}

function evaluatePredictions(storage, history) {
    storage.forEach(p => {
        if (p.ket_qua && p.ket_qua !== "...") return;
        const real = history.find(h => h.id === p.phien);
        if (real?.dices?.length === 3) {
            const sum = real.dices.reduce((a,b) => a+b, 0);
            const result = sum >= 11 ? "TÀI" : "XỈU";
            p.ket_qua = `${result} (${sum})`;
            p.danh_gia = (p.du_doan === result) ? "THẮNG" : "THUA";
        }
    });
}

function getStats(storage) {
    const finished = storage.filter(i => i.danh_gia !== "ĐANG CHỜ" && i.ket_qua);
    const total = finished.length;
    const win = finished.filter(i => i.danh_gia === "THẮNG").length;
    const lose = finished.filter(i => i.danh_gia === "THUA").length;
    const rate = total === 0 ? 0 : (win / total) * 100;
    return {
        tong_du_doan: total,
        tong_thang: win,
        tong_thua: lose,
        ti_le_chinh_xac: `${rate.toFixed(2)}%`,
        lich_su: storage.slice(-20).reverse()
    };
}

// Hàm tiện ích
function generateSeed(history, count = 8) {
    if (history.length < count) return null;
    const seedString = history.slice(0, count).map(item => item.dices ? item.dices.join('') : '').join('');
    if (!seedString) return null;
    return crypto.createHash('md5').update(seedString).digest('hex');
}

function randomDice(seed) {
    if (!seed) return [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1];
    const hash = crypto.createHash('md5').update(seed).digest('hex');
    return [
        parseInt(hash.substring(0,2),16) % 6 +1,
        parseInt(hash.substring(2,4),16) % 6 +1,
        parseInt(hash.substring(4,6),16) % 6 +1
    ];
}

function formatAIResponse(raw, brain) {
    const list = raw?.list;
    if (!list || list.length === 0) return { error: "Không có dữ liệu" };
    const data = list[0];
    const ai = brain.analyze();
    const dices = data.dices && data.dices.length === 3 ? data.dices : randomDice(generateSeed(list, 8));
    const sum = dices.reduce((a,b) => a+b, 0);
    return {
        phien: data.id,
        xuc_xac_1: dices[0],
        xuc_xac_2: dices[1],
        xuc_xac_3: dices[2],
        tong: sum,
        ket_qua: sum >= 11 ? "TÀI" : "XỈU",
        phien_tiep_theo: data.id + 1,
        du_doan: ai.prediction,
        do_tin_cay: { TÀI: `${ai.confidenceTai}%`, XỈU: `${ai.confidenceXiu}%` },
        ly_do: ai.reason,
        pattern: ai.pattern
    };
}

// ========== ROUTES CHÍNH ==========
app.get("/taixiu", async (req, res) => {
    try {
        const r = await http.get(URL_TRUYEN_THONG);
        feedBrain(brainNormal, r.data.list);
        res.json(formatAIResponse(r.data, brainNormal));
    } catch { res.status(500).json({ error: "Lỗi cổng Thường" }); }
});

app.get("/taixiumd5", async (req, res) => {
    try {
        const r = await http.get(URL_MD5);
        feedBrain(brainMd5, r.data.list);
        res.json(formatAIResponse(r.data, brainMd5));
    } catch { res.status(500).json({ error: "Lỗi cổng MD5" }); }
});

app.get("/all", async (req, res) => {
    try {
        const [a, b] = await Promise.all([http.get(URL_TRUYEN_THONG), http.get(URL_MD5)]);
        feedBrain(brainNormal, a.data.list);
        feedBrain(brainMd5, b.data.list);
        res.json({
            taixiu: formatAIResponse(a.data, brainNormal),
            taixiumd5: formatAIResponse(b.data, brainMd5)
        });
    } catch { res.status(500).json({ error: "Lỗi hỗn hợp" }); }
});

app.get("/thongke", (req, res) => res.json(getStats(predictionsNormal)));
app.get("/thongkemd5", (req, res) => res.json(getStats(predictionsMd5)));

// ========== ENDPOINT GIAO DIỆN DỰ ĐOÁN “SẠCH” ==========
app.get("/dudoan/tx", async (req, res) => {
    try {
        const r = await http.get(URL_TRUYEN_THONG);
        feedBrain(brainNormal, r.data.list);
        const ai = brainNormal.analyze();
        const data = r.data.list[0];
        const nextPhien = data.id + 1;
        const html = `<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Dự Đoán Tài Xỉu Thường</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <meta http-equiv="refresh" content="5">
</head>
<body class="bg-gray-950 text-white flex items-center justify-center min-h-screen">
    <div class="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl text-center max-w-md w-full">
        <h2 class="text-2xl font-bold text-cyan-400 mb-2">🎲 DỰ ĐOÁN TÀI XỈU</h2>
        <p class="text-slate-400 text-sm mb-6">Cổng Truyền Thống • Tự động cập nhật mỗi 5s</p>
        <div class="bg-slate-800 rounded-xl p-6 mb-4">
            <p class="text-lg text-slate-300">Phiên tiếp theo <span class="text-white font-mono">#${nextPhien}</span></p>
            <p class="text-4xl font-black mt-3 ${ai.prediction === 'TÀI' ? 'text-red-400' : 'text-sky-400'}">${ai.prediction}</p>
            <div class="flex justify-center gap-4 mt-2 text-sm">
                <span class="text-red-400">Tài ${ai.confidenceTai}%</span>
                <span class="text-sky-400">Xỉu ${ai.confidenceXiu}%</span>
            </div>
        </div>
        <p class="text-xs text-slate-500">🧠 ${ai.reason}</p>
        <p class="text-xs text-slate-600 mt-1">Pattern: ${ai.pattern}</p>
    </div>
</body>
</html>`;
        res.send(html);
    } catch (e) {
        res.status(500).send("Lỗi lấy dữ liệu dự đoán");
    }
});

app.get("/dudoan/txmd5", async (req, res) => {
    try {
        const r = await http.get(URL_MD5);
        feedBrain(brainMd5, r.data.list);
        const ai = brainMd5.analyze();
        const data = r.data.list[0];
        const nextPhien = data.id + 1;
        const html = `<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Dự Đoán Tài Xỉu MD5</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <meta http-equiv="refresh" content="5">
</head>
<body class="bg-gray-950 text-white flex items-center justify-center min-h-screen">
    <div class="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl text-center max-w-md w-full">
        <h2 class="text-2xl font-bold text-purple-400 mb-2">🔒 DỰ ĐOÁN TÀI XỈU MD5</h2>
        <p class="text-slate-400 text-sm mb-6">Cổng MD5 • Tự động cập nhật mỗi 5s</p>
        <div class="bg-slate-800 rounded-xl p-6 mb-4">
            <p class="text-lg text-slate-300">Phiên tiếp theo <span class="text-white font-mono">#${nextPhien}</span></p>
            <p class="text-4xl font-black mt-3 ${ai.prediction === 'TÀI' ? 'text-red-400' : 'text-sky-400'}">${ai.prediction}</p>
            <div class="flex justify-center gap-4 mt-2 text-sm">
                <span class="text-red-400">Tài ${ai.confidenceTai}%</span>
                <span class="text-sky-400">Xỉu ${ai.confidenceXiu}%</span>
            </div>
        </div>
        <p class="text-xs text-slate-500">🧠 ${ai.reason}</p>
        <p class="text-xs text-slate-600 mt-1">Pattern: ${ai.pattern}</p>
    </div>
</body>
</html>`;
        res.send(html);
    } catch (e) {
        res.status(500).send("Lỗi lấy dữ liệu dự đoán MD5");
    }
});

// Dashboard tổng (giữ nguyên)
app.get("/", (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html lang="vi">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>AI VIP BRAIN PANEL v2.0</title>
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
        <div class="max-w-7xl mx-auto">
            <div class="flex flex-col md:flex-row justify-between items-center border-b border-slate-800 pb-6 mb-8 gap-4">
                <div>
                    <h1 class="text-3xl font-black tracking-wider text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-blue-500 to-purple-600">AI DETECTOR TRADING BOT VIP</h1>
                    <p class="text-xs text-slate-400 mt-1">Hybrid AI: Markov bậc cao + Phân tích cầu + Bẻ cầu + Xu hướng Bayes</p>
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
                        <h2 class="text-xl font-bold text-cyan-400">⚡ TRUYỀN THỐNG</h2>
                        <div id="summary-normal" class="flex gap-2 text-xs"></div>
                    </div>
                    <div class="table-container max-h-[520px] overflow-y-auto rounded-xl border border-slate-800">
                        <table class="w-full text-center border-collapse">
                            <thead class="bg-slate-950 text-slate-400 text-xs sticky top-0 uppercase">
                                <tr><th class="py-3 px-2">Phiên</th><th class="py-3 px-2">Pattern</th><th class="py-3 px-2">AI Báo</th><th class="py-3 px-2">Kết Quả</th><th class="py-3 px-2">Đánh Giá</th></tr>
                            </thead>
                            <tbody id="body-normal" class="divide-y divide-slate-800/60 text-sm font-medium"></tbody>
                        </table>
                    </div>
                </div>
                <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl">
                    <div class="flex justify-between items-center mb-4">
                        <h2 class="text-xl font-bold text-purple-400">🔒 MD5 VIP</h2>
                        <div id="summary-md5" class="flex gap-2 text-xs"></div>
                    </div>
                    <div class="table-container max-h-[520px] overflow-y-auto rounded-xl border border-slate-800">
                        <table class="w-full text-center border-collapse">
                            <thead class="bg-slate-950 text-slate-400 text-xs sticky top-0 uppercase">
                                <tr><th class="py-3 px-2">Phiên</th><th class="py-3 px-2">Pattern</th><th class="py-3 px-2">AI Báo</th><th class="py-3 px-2">Kết Quả</th><th class="py-3 px-2">Đánh Giá</th></tr>
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
                } else if(item.danh_gia === "THUA") {
                    statusBadge = '<span class="bg-rose-950/80 text-rose-400 px-2.5 py-1 rounded-md text-xs font-bold border border-rose-900/50 glow-lose">THUA</span>';
                } else {
                    statusBadge = '<span class="bg-amber-950/80 text-amber-400 px-2.5 py-1 rounded-md text-xs font-medium border border-amber-900/50 animate-pulse">ĐANG CHỜ</span>';
                }
                const aiColor = item.du_doan === "TÀI" ? "text-red-400" : "text-sky-400";
                return \`<tr class="hover:bg-slate-800/40 transition-colors">
                    <td class="py-3 px-2 font-mono text-slate-400 text-xs">#\${item.phien}</td>
                    <td class="py-3 px-2 text-xs text-slate-400">\${item.chi_tiet || "Đang quét"}</td>
                    <td class="py-3 px-2 font-bold \${aiColor}">\${item.du_doan}</td>
                    <td class="py-3 px-2 text-slate-300 font-semibold">\${item.ket_qua || "..."}</td>
                    <td class="py-3 px-2">\${statusBadge}</td>
                </tr>\`;
            }
            async function refreshUI() {
                try {
                    document.getElementById('live-clock').innerText = "Live: " + new Date().toLocaleTimeString();
                    const [resNormal, resMd5] = await Promise.all([
                        fetch('/thongke').then(r => r.json()),
                        fetch('/thongkemd5').then(r => r.json())
                    ]);
                    document.getElementById('summary-normal').innerHTML = \`<span class="bg-slate-800 text-slate-300 px-2 py-1 rounded">Mẫu: \${resNormal.tong_du_doan}</span><span class="bg-emerald-900/30 text-emerald-400 px-2 py-1 rounded">Thắng: \${resNormal.tong_thang}</span><span class="bg-blue-900/40 text-cyan-400 px-2 py-1 rounded font-bold">\${resNormal.ti_le_chinh_xac}</span>\`;
                    document.getElementById('body-normal').innerHTML = resNormal.lich_su.map(buildRowHtml).join('') || '<tr><td colspan="5" class="py-4 text-slate-500">Đang tải...</td></tr>';
                    document.getElementById('summary-md5').innerHTML = \`<span class="bg-slate-800 text-slate-300 px-2 py-1 rounded">Mẫu: \${resMd5.tong_du_doan}</span><span class="bg-emerald-900/30 text-emerald-400 px-2 py-1 rounded">Thắng: \${resMd5.tong_thang}</span><span class="bg-purple-900/40 text-purple-400 px-2 py-1 rounded font-bold">\${resMd5.ti_le_chinh_xac}</span>\`;
                    document.getElementById('body-md5').innerHTML = resMd5.lich_su.map(buildRowHtml).join('') || '<tr><td colspan="5" class="py-4 text-slate-500">Đang tải...</td></tr>';
                } catch(e) { console.log(e); }
            }
            setInterval(refreshUI, 3000);
            refreshUI();
        </script>
    </body>
    </html>`;
    res.send(html);
});

app.listen(PORT, () => {
    console.log("======================================================");
    console.log(`🚀 VIP AI BRAIN ENGINE ĐÃ SẴN SÀNG TẠI CỔNG ${PORT}`);
    console.log(`🌐 Dashboard: http://localhost:${PORT}`);
    console.log(`🎯 Dự đoán TX: http://localhost:${PORT}/dudoan/tx`);
    console.log(`🔐 Dự đoán MD5: http://localhost:${PORT}/dudoan/txmd5`);
    console.log("======================================================");
});