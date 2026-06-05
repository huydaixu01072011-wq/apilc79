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

// =================== MEGAVIP BRAIN ULTRA v4.0 ===================
class MegaVIPBrainUltra {
    constructor() {
        this.txHistory = [];
        this.diceHistory = [];
        this.maxMarkovOrder = 7;
        this.transitionMatrices = {};
        this.patternLibrary = this.buildPatternLibrary();
        this.metaMemory = [];
        this.maxMetaMemory = 60;
        this.weights = {
            markov: 0.22,
            pattern: 0.28,
            cycle: 0.18,
            break: 0.12,
            trend: 0.12,
            volatility: 0.08
        };
        this.lastUpdateTime = Date.now();
        this.consecutiveLosses = 0;
        this.lastComponentProbs = null;
    }

    static diceCategory(diem) {
        if (diem <= 2) return 1;
        if (diem <= 4) return 2;
        return 3;
    }

    loadData(rawList) {
        if (!rawList || rawList.length === 0) return;
        const clone = [...rawList].reverse();
        this.txHistory = [];
        this.diceHistory = [];
        clone.forEach(item => {
            if (!item.dices || item.dices.length !== 3) return;
            const sum = item.dices.reduce((a,b) => a+b, 0);
            this.txHistory.push(sum >= 11 ? "TÀI" : "XỈU");
            item.dices.forEach(d => this.diceHistory.push(MegaVIPBrainUltra.diceCategory(d)));
        });
        const maxLen = 150;
        if (this.txHistory.length > maxLen) {
            this.txHistory = this.txHistory.slice(-maxLen);
            this.diceHistory = this.diceHistory.slice(-maxLen * 3);
        }
        this.buildMarkovMatrices();
        this.updateMetaWeights();
    }

    buildMarkovMatrices() {
        this.transitionMatrices = {};
        const len = this.diceHistory.length;
        for (let order = 1; order <= this.maxMarkovOrder; order++) {
            const matrix = new Map();
            if (len > order) {
                for (let i = order; i < len; i++) {
                    const state = [];
                    for (let j = order-1; j >= 0; j--) state.push(this.diceHistory[i - j]);
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

    predictMarkovProb() {
        const len = this.diceHistory.length;
        if (len < 1) return 0.5;
        for (let order = this.maxMarkovOrder; order >= 1; order--) {
            if (len < order) continue;
            const state = [];
            for (let j = order-1; j >= 0; j--) state.push(this.diceHistory[len - 1 - j]);
            const key = state.join(',');
            const matrix = this.transitionMatrices[order];
            if (matrix && matrix.has(key)) {
                const nextCounts = matrix.get(key);
                let total = 0;
                for (let cnt of nextCounts.values()) total += cnt;
                let probCat3 = (nextCounts.get(3) || 0) / total;
                let probTai = probCat3 * 0.72 + (nextCounts.get(2)||0)/total * 0.52 + (nextCounts.get(1)||0)/total * 0.28;
                return Math.min(0.95, Math.max(0.05, probTai));
            }
        }
        const counts = {1:0,2:0,3:0};
        this.diceHistory.forEach(c => counts[c]++);
        const total = this.diceHistory.length;
        let probTai = (counts[3]/total)*0.7 + (counts[2]/total)*0.5 + (counts[1]/total)*0.3;
        return 0.3 + probTai * 0.4;
    }

    buildPatternLibrary() {
        return [
            { name: "BỆT TÀI 5", seq: ["TÀI","TÀI","TÀI","TÀI","TÀI"], next: "TÀI", conf: 94 },
            { name: "BỆT XỈU 5", seq: ["XỈU","XỈU","XỈU","XỈU","XỈU"], next: "XỈU", conf: 94 },
            { name: "1-1-1 TÀI", seq: ["XỈU","TÀI","XỈU","TÀI","XỈU","TÀI"], next: "XỈU", conf: 88 },
            { name: "1-1-1 XỈU", seq: ["TÀI","XỈU","TÀI","XỈU","TÀI","XỈU"], next: "TÀI", conf: 88 },
            { name: "2-2-2 TÀI", seq: ["TÀI","TÀI","XỈU","XỈU","TÀI","TÀI","XỈU"], next: "TÀI", conf: 85 },
            { name: "2-2-2 XỈU", seq: ["XỈU","XỈU","TÀI","TÀI","XỈU","XỈU","TÀI"], next: "XỈU", conf: 85 },
            { name: "3-1-2 TÀI", seq: ["TÀI","TÀI","TÀI","XỈU","XỈU","XỈU","TÀI"], next: "TÀI", conf: 82 },
            { name: "3-1-2 XỈU", seq: ["XỈU","XỈU","XỈU","TÀI","TÀI","TÀI","XỈU"], next: "XỈU", conf: 82 },
            { name: "LC79 DUAL", seq: ["TÀI","XỈU","TÀI","TÀI","XỈU","XỈU","TÀI","XỈU","TÀI"], next: "TÀI", conf: 90 },
            { name: "LC79 REV", seq: ["XỈU","TÀI","XỈU","XỈU","TÀI","TÀI","XỈU","TÀI","XỈU"], next: "XỈU", conf: 90 },
            { name: "HARMONIC 3", seq: ["TÀI","XỈU","XỈU","TÀI","TÀI","XỈU","TÀI","XỈU","XỈU"], next: "TÀI", conf: 86 },
            { name: "HARMONIC 3R", seq: ["XỈU","TÀI","TÀI","XỈU","XỈU","TÀI","XỈU","TÀI","TÀI"], next: "XỈU", conf: 86 },
            { name: "BẺ 4 TÀI", seq: ["TÀI","TÀI","TÀI","TÀI","XỈU"], next: "XỈU", conf: 91, break: true },
            { name: "BẺ 4 XỈU", seq: ["XỈU","XỈU","XỈU","XỈU","TÀI"], next: "TÀI", conf: 91, break: true },
            { name: "BẺ 5 TÀI", seq: ["TÀI","TÀI","TÀI","TÀI","TÀI","XỈU"], next: "XỈU", conf: 95, break: true },
            { name: "BẺ 5 XỈU", seq: ["XỈU","XỈU","XỈU","XỈU","XỈU","TÀI"], next: "TÀI", conf: 95, break: true },
            { name: "XEN KẸP", seq: ["TÀI","XỈU","TÀI","XỈU","TÀI","XỈU","TÀI"], next: "TÀI", conf: 83 },
            { name: "XEN KẸP X", seq: ["XỈU","TÀI","XỈU","TÀI","XỈU","TÀI","XỈU"], next: "XỈU", conf: 83 },
            { name: "CHUỖI TÀI 3", seq: ["TÀI","TÀI","TÀI"], next: "TÀI", conf: 78 },
            { name: "CHUỖI XỈU 3", seq: ["XỈU","XỈU","XỈU"], next: "XỈU", conf: 78 },
            { name: "ĐẢO 2 TÀI", seq: ["TÀI","XỈU","TÀI","TÀI","XỈU","TÀI"], next: "TÀI", conf: 81 },
            { name: "ĐẢO 2 XỈU", seq: ["XỈU","TÀI","XỈU","XỈU","TÀI","XỈU"], next: "XỈU", conf: 81 },
        ];
    }

    detectPattern() {
        const tx = this.txHistory;
        const len = tx.length;
        if (len < 3) return null;
        const last = tx.slice(-12);
        for (let p of this.patternLibrary) {
            if (p.seq.length > last.length) continue;
            let match = true;
            for (let i = 0; i < p.seq.length; i++) {
                if (last[last.length - p.seq.length + i] !== p.seq[i]) {
                    match = false;
                    break;
                }
            }
            if (match) return p;
        }
        return null;
    }

    patternProbTai() {
        const pat = this.detectPattern();
        if (!pat) return 0.5;
        let prob = pat.next === "TÀI" ? pat.conf/100 : 1 - pat.conf/100;
        if (pat.break) prob = prob * 1.2;
        return Math.min(0.98, Math.max(0.02, prob));
    }

    detectCycle() {
        const tx = this.txHistory;
        const len = tx.length;
        if (len < 8) return null;
        for (let period = 2; period <= 12; period++) {
            if (len < period * 2) continue;
            const lastCycle = tx.slice(-period);
            const prevCycle = tx.slice(-2*period, -period);
            let matches = 0;
            for (let i=0; i<period; i++) if (lastCycle[i] === prevCycle[i]) matches++;
            if (matches / period > 0.85) {
                let confidence = 70 + (matches/period)*20;
                return { period, prediction: lastCycle[0], confidence };
            }
        }
        return null;
    }

    cycleProbTai() {
        const cycle = this.detectCycle();
        if (!cycle) return 0.5;
        return cycle.prediction === "TÀI" ? cycle.confidence/100 : 1 - cycle.confidence/100;
    }

    detectBreak() {
        const tx = this.txHistory;
        const len = tx.length;
        if (len < 6) return null;
        const recent = tx.slice(-12);
        let streak = 1;
        for (let i=recent.length-2; i>=0; i--) {
            if (recent[i] === recent[recent.length-1]) streak++;
            else break;
        }
        if (streak >= 4) {
            const predicted = recent[recent.length-1] === "TÀI" ? "XỈU" : "TÀI";
            const confidence = Math.min(94, 70 + streak * 5);
            return { prediction: predicted, confidence, name: `BẺ BỆT ${streak}` };
        }
        let changes = 0;
        for (let i=1; i<recent.length; i++) if (recent[i] !== recent[i-1]) changes++;
        const volatility = changes / (recent.length-1);
        if (volatility > 0.7 && len > 10) {
            const last = recent[recent.length-1];
            return { prediction: last, confidence: 76, name: "BÙNG NỔ ĐẢO CHIỀU" };
        }
        return null;
    }

    breakProbTai() {
        const brk = this.detectBreak();
        if (!brk) return 0.5;
        return brk.prediction === "TÀI" ? brk.confidence/100 : 1 - brk.confidence/100;
    }

    trendProbTai() {
        const recent = this.txHistory.slice(-30);
        if (recent.length < 10) return 0.5;
        const taiCount = recent.filter(r => r === "TÀI").length;
        const ratio = taiCount / recent.length;
        const ema = ratio * 0.3 + 0.5 * 0.7;
        return 0.3 + ema * 0.4;
    }

    volatilityProbTai() {
        const recent = this.txHistory.slice(-20);
        if (recent.length < 5) return 0.5;
        let changes = 0;
        for (let i=1; i<recent.length; i++) if (recent[i] !== recent[i-1]) changes++;
        const vol = changes / (recent.length-1);
        if (vol > 0.6) {
            const last = recent[recent.length-1];
            const predicted = last === "TÀI" ? "XỈU" : "TÀI";
            return predicted === "TÀI" ? 0.65 : 0.35;
        }
        return 0.5;
    }

    updateMetaWeights() {
        if (this.txHistory.length < 15) return;
        if (Date.now() - this.lastUpdateTime < 30000) return;
        this.lastUpdateTime = Date.now();
        if (this.metaMemory.length < 10) return;

        let componentAccuracy = { markov:0, pattern:0, cycle:0, break:0, trend:0, volatility:0 };
        let count = 0;
        for (let mem of this.metaMemory) {
            if (!mem.actual) continue;
            const actualTai = mem.actual === "TÀI" ? 1 : 0;
            for (let key in componentAccuracy) {
                const predProb = mem.componentProbs[key];
                if (predProb !== undefined) {
                    const pred = predProb >= 0.5 ? 1 : 0;
                    if (pred === actualTai) componentAccuracy[key] = (componentAccuracy[key] || 0) + 1;
                }
            }
            count++;
        }
        if (count === 0) return;
        const alpha = 0.35;
        let totalNew = 0;
        let newWeights = {};
        for (let key in this.weights) {
            let acc = (componentAccuracy[key] || 0) / count;
            acc = Math.min(0.95, Math.max(0.05, acc));
            newWeights[key] = acc;
            totalNew += acc;
        }
        if (totalNew > 0) {
            for (let key in newWeights) {
                newWeights[key] /= totalNew;
                this.weights[key] = this.weights[key] * (1 - alpha) + newWeights[key] * alpha;
            }
        }
        let sum = 0;
        for (let key in this.weights) sum += this.weights[key];
        for (let key in this.weights) this.weights[key] /= sum;
    }

    analyze() {
        const probMarkov = this.predictMarkovProb();
        const probPattern = this.patternProbTai();
        const probCycle = this.cycleProbTai();
        let probBreak = this.breakProbTai();
        const probTrend = this.trendProbTai();
        const probVol = this.volatilityProbTai();

        if (this.consecutiveLosses >= 2) probBreak = Math.min(0.98, probBreak * (1 + this.consecutiveLosses * 0.1));

        let finalProb = 
            probMarkov * this.weights.markov +
            probPattern * this.weights.pattern +
            probCycle * this.weights.cycle +
            probBreak * this.weights.break +
            probTrend * this.weights.trend +
            probVol * this.weights.volatility;

        finalProb = 1 / (1 + Math.exp(-12 * (finalProb - 0.5)));
        finalProb = Math.min(0.97, Math.max(0.03, finalProb));

        const prediction = finalProb >= 0.5 ? "TÀI" : "XỈU";
        const confidenceTai = Math.round(finalProb * 100);
        const confidenceXiu = 100 - confidenceTai;

        this.lastComponentProbs = {
            markov: probMarkov,
            pattern: probPattern,
            cycle: probCycle,
            break: probBreak,
            trend: probTrend,
            volatility: probVol
        };

        let patternName = "KHÔNG CẦU";
        const pat = this.detectPattern();
        if (pat) patternName = pat.name;
        const brk = this.detectBreak();
        if (brk && brk.name) patternName = brk.name;

        let reason = `M${Math.round(probMarkov*100)}% P${Math.round(probPattern*100)}% C${Math.round(probCycle*100)}% B${Math.round(probBreak*100)}% T${Math.round(probTrend*100)}% V${Math.round(probVol*100)}%`;
        return { prediction, confidenceTai, confidenceXiu, reason, pattern: patternName };
    }

    recordResult(actual) {
        if (this.lastComponentProbs) {
            this.metaMemory.push({ actual, componentProbs: { ...this.lastComponentProbs }, timestamp: Date.now() });
            if (this.metaMemory.length > this.maxMetaMemory) this.metaMemory.shift();
            const lastPred = this.lastComponentProbs.markov >= 0.5 ? "TÀI" : "XỈU";
            if (lastPred !== actual) this.consecutiveLosses++;
            else this.consecutiveLosses = 0;
            this.lastComponentProbs = null;
            this.updateMetaWeights();
        }
    }
}

// Khởi tạo hai bộ não
const brainNormal = new MegaVIPBrainUltra();
const brainMd5 = new MegaVIPBrainUltra();

// Helper functions
function feedBrain(brain, rawList) {
    if (rawList && rawList.length > 0) brain.loadData(rawList);
}

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

function evaluatePredictions(storage, history, brain) {
    storage.forEach(p => {
        if (p.ket_qua && p.ket_qua !== "...") return;
        const real = history.find(h => h.id === p.phien);
        if (real?.dices?.length === 3) {
            const sum = real.dices.reduce((a,b) => a+b, 0);
            const result = sum >= 11 ? "TÀI" : "XỈU";
            p.ket_qua = `${result} (${sum})`;
            p.danh_gia = (p.du_doan === result) ? "THẮNG" : "THUA";
            brain.recordResult(result);
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
            evaluatePredictions(predictionsNormal, historyNormal, brainNormal);
        }
        if (md5?.data?.list) {
            historyMd5 = md5.data.list;
            feedBrain(brainMd5, historyMd5);
            updatePredictionTable(predictionsMd5, historyMd5, brainMd5);
            evaluatePredictions(predictionsMd5, historyMd5, brainMd5);
        }
    } catch (e) {
        console.log("Poll error:", e.message);
    }
}
setInterval(poll, 3000);

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
        do_tin_cay: { TAI: `${ai.confidenceTai}%`, XIU: `${ai.confidenceXiu}%` },
        ly_do: ai.reason,
        pattern: ai.pattern
    };
}

// Express routes
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

// Dashboard đơn giản
app.get("/", (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><meta http-equiv="refresh" content="5"><title>MEGA VIP BRAIN ULTRA v4.0</title><script src="https://cdn.tailwindcss.com"></script></head>
    <body class="bg-gray-950 text-white p-6"><div class="max-w-6xl mx-auto">
    <h1 class="text-3xl font-bold text-cyan-400">🧠 LC79 ULTRA v4.0 - Tự học siêu cấp</h1>
    <div class="grid grid-cols-2 gap-6 mt-6">
    <div class="bg-slate-900 p-4 rounded-2xl"><h2 class="text-xl text-cyan-400">📊 Truyền thống</h2><div id="stats1"></div><div id="table1"></div></div>
    <div class="bg-slate-900 p-4 rounded-2xl"><h2 class="text-xl text-purple-400">🔐 MD5</h2><div id="stats2"></div><div id="table2"></div></div>
    </div></div>
    <script>
    async function load(){ 
        let a=await fetch('/thongke').then(r=>r.json()); 
        let b=await fetch('/thongkemd5').then(r=>r.json());
        document.getElementById('stats1').innerHTML=\`Tỉ lệ: \${a.ti_le_chinh_xac} | Thắng: \${a.tong_thang} / \${a.tong_du_doan}\`;
        document.getElementById('stats2').innerHTML=\`Tỉ lệ: \${b.ti_le_chinh_xac} | Thắng: \${b.tong_thang} / \${b.tong_du_doan}\`;
        document.getElementById('table1').innerHTML='<table class="w-full text-sm">'+a.lich_su.map(i=>'<tr><td>#'+i.phien+'</td><td>'+i.du_doan+'</td><td>'+i.ket_qua+'</td><td class="'+(i.danh_gia==='THẮNG'?'text-green-400':'text-red-400')+'">'+i.danh_gia+'</td></tr>').join('')+'</table>';
        document.getElementById('table2').innerHTML='<table class="w-full text-sm">'+b.lich_su.map(i=>'<tr><td>#'+i.phien+'</td><td>'+i.du_doan+'</td><td>'+i.ket_qua+'</td><td class="'+(i.danh_gia==='THẮNG'?'text-green-400':'text-red-400')+'">'+i.danh_gia+'</td></tr>').join('')+'</table>';
    }
    setInterval(load,3000); load();
    </script>
    </body></html>
    `);
});

app.listen(PORT, () => {
    console.log(`⚡ MEGA VIP BRAIN ULTRA v4.0 running on port ${PORT}`);
    console.log(`🌐 Dashboard: http://localhost:${PORT}`);
});